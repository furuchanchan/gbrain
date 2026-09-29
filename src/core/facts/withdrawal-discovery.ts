import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { getCode } from '../retry-matcher.ts';
import { parseRowCells, isSeparatorRow, stripStrikethrough } from '../fence-shared.ts';
import { withdrawalFenceBlocks, ambiguousWithdrawalFenceSegments } from './withdrawal-overlay.ts';

export const WITHDRAWAL_LIMITS = { targets: 256, targetBytes: 1024 * 1024, scanMs: 10_000, batch: 128 } as const;
export interface WithdrawalTarget { slug: string; page_id: number; revision: string }
export interface WithdrawalClaim { visibility: string; fact_hash: string }

function refuse(code = 'withdrawal_capacity'): never {
  throw new OperationError(code, 'Withdrawal discovery could not prove a bounded complete target set. This attempt committed no withdrawal or page changes; earlier durable intent remains retained.',
    'Do not retry unchanged or split/delete the source. Keep mutation workers quiesced and inspect the source with the host operator; repair malformed fact fences before retrying. See docs/guides/concurrent-writes.md#withdrawal-recovery.');
}

interface PendingPlan { source_id: string; claims_key: string; claims: string; source_incarnation: string; phase: ScanPhase; cursor: number; affected: number[]; started_at: string }

// The pending receipt carries the full plan so the outermost caller can
// persist it AFTER the rolled-back transaction releases the connection —
// on PGLite's single connection no write can interleave inside an open tx.
export function persistWithdrawalDiscoveryPlan(engine: BrainEngine, error: unknown): Promise<unknown> {
  const plan = (error as { pendingPlan?: PendingPlan }).pendingPlan;
  if (!plan) return Promise.resolve();
  return engine.executeRaw(`INSERT INTO fact_withdrawal_discovery(source_id,claims_key,claims,source_incarnation,phase,cursor,affected,started_at,updated_at)
    VALUES($1,$2,$3::text::jsonb,$4::uuid,$5,$6,$7::int[],$8::timestamptz,now())
    ON CONFLICT (source_id,claims_key) DO UPDATE SET phase=EXCLUDED.phase,cursor=EXCLUDED.cursor,
      affected=EXCLUDED.affected,claims=EXCLUDED.claims,source_incarnation=EXCLUDED.source_incarnation,updated_at=now()`,
    [plan.source_id, plan.claims_key, plan.claims, plan.source_incarnation, plan.phase, plan.cursor, plan.affected, plan.started_at]);
}

function pending(plan: PendingPlan): never {
  const error = new OperationError('withdrawal_pending', `Withdrawal discovery is still scanning the source (phase: ${plan.phase}); retained progress resumes on the next attempt.`,
    'Retry the same operation — committed discovery progress resumes from its cursor. See docs/guides/concurrent-writes.md#withdrawal-recovery.');
  (error as { pendingPlan?: PendingPlan }).pendingPlan = plan;
  throw error;
}

export function ambiguousFenceClaims(body: string): Array<{ claim: string; visibility: string | null }> {
  const claims: Array<{ claim: string; visibility: string | null }> = [];
  for (const segment of ambiguousWithdrawalFenceSegments(body)) for (const line of segment.split('\n')) {
    const cells = parseRowCells(line);
    if (!cells || isSeparatorRow(cells) || cells[1]?.trim().toLowerCase() === 'claim') continue;
    const { text, struck } = stripStrikethrough((cells[1] ?? '').trim());
    if (!struck && text) claims.push({ claim: text, visibility: ['private', 'world'].includes(cells[4]?.toLowerCase()) ? cells[4].toLowerCase() : null });
  }
  return claims;
}

type ScanPhase = 'facts' | 'pages' | 'chunks' | 'drift_pages' | 'drift_chunks' | 'drift_facts';
const PHASES: readonly ScanPhase[] = ['facts', 'pages', 'chunks', 'drift_pages', 'drift_chunks', 'drift_facts'];
const DRIFT_PHASES: ReadonlySet<ScanPhase> = new Set(['drift_pages', 'drift_chunks', 'drift_facts']);
interface StoredPlan { phase: ScanPhase; cursor: number; affected: number[]; source_incarnation: string; started_at: string }
interface ScanOpts { scanMs?: number; batch?: number }
type ScanRow = { id: number; page_id?: number; compiled_truth?: string; timeline?: string; chunk_text?: string; drift_ts?: string };

function claimsKey(claims: readonly WithdrawalClaim[]): string {
  const canonical = claims.map(claim => [claim.visibility, claim.fact_hash]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function pageIncoming(page: { id: number; compiled_truth: string; timeline: string }) {
  return [page.compiled_truth, page.timeline].flatMap(body => [
    ...withdrawalFenceBlocks(body).filter(block => !block.parsed.warnings.length).flatMap(block => block.parsed.facts.map(f => ({ id: page.id, claim: f.claim, visibility: f.visibility, ambiguous: false }))),
    ...ambiguousFenceClaims(body).map(f => ({ id: page.id, ...f, ambiguous: true })),
  ]);
}

function chunkIncoming(chunk: { id: number; page_id: number; chunk_text: string }) {
  const rows = [{ id: chunk.page_id, claim: chunk.chunk_text, visibility: null as string | null, ambiguous: false }];
  for (const line of chunk.chunk_text.split('\n')) {
    const cells = parseRowCells(line.slice(Math.max(0, line.indexOf('|'))));
    if (!cells || isSeparatorRow(cells) || !cells[1]) continue;
    const { text, struck } = stripStrikethrough(cells[1]);
    if (!struck) rows.push({ id: chunk.page_id, claim: text, visibility: ['private', 'world'].includes(cells[4]) ? cells[4] : null, ambiguous: false });
  }
  return rows;
}

// #5674 — resumable, source-revision-bound discovery. Whole-source inventory
// caps used to refuse before matching on large brains; now each batch is
// bounded (batch rows, one match query) and progress commits to
// fact_withdrawal_discovery keyed by the claim set, so a scan that outlives
// one invocation resumes from its cursor instead of failing outright.
//
// Review round 2 — coverage across concurrent writes and plan hygiene:
// - Facts provenance is a bounded phase (`facts`, facts.id keyset with a
//   per-batch fingerprint join) instead of a single whole-source join that
//   re-ran outside the resumable loop on every retry — large sources make
//   committed progress between pending receipts, and `drift_facts` covers
//   rows created after the facts scan inside the plan's started_at window.
// - Each drift stream orders by its non-monotonic window key
//   (pages.updated_at / facts.created_at, id): a row updated while its drift
//   phase is mid-scan sorts past the cursor and is re-covered in the same
//   pass, and a persisted drift phase restarts at the window head — a low-id
//   row written between invocations is never skipped by an id cursor.
// - A final probe re-runs every drift fetcher at its last-seen tuple right
//   before commit; any uncovered row suspends instead of returning a target
//   set that was not provably complete at the last read.
// - Plans expire after one idle hour (resumed plans refresh updated_at on
//   every persist, so only abandoned rows age out) and the GC sweep runs on
//   every entry, reaping expired and source-orphaned rows regardless of
//   whether the current plan commits.
// Callers must pass an engine handle whose writes autocommit (a tx-bound
// handle rolls the plan back with the caller's transaction).
export async function discoverWithdrawalTargets(engine: BrainEngine, sourceId: string, claims: readonly WithdrawalClaim[], opts: ScanOpts = {}): Promise<WithdrawalTarget[]> {
  if (!claims.length) return [];
  if (claims.length > WITHDRAWAL_LIMITS.targets) refuse();
  const scanMs = opts.scanMs ?? WITHDRAWAL_LIMITS.scanMs;
  const batch = opts.batch ?? WITHDRAWAL_LIMITS.batch;
  const deadline = performance.now() + scanMs;
  const key = claimsKey(claims);
  const claimsJson = JSON.stringify(claims);
  // Sweep expired and source-orphaned plans on every entry — the old
  // success-path-only GC let abandoned and deleted-source rows persist.
  await engine.executeRaw(`DELETE FROM fact_withdrawal_discovery WHERE updated_at < now() - interval '1 hour'
    OR NOT EXISTS (SELECT 1 FROM sources WHERE sources.id = fact_withdrawal_discovery.source_id)`);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  if (!source) return [];
  const stored = await engine.executeRaw<StoredPlan>(`SELECT phase,cursor,affected,source_incarnation,started_at::text FROM fact_withdrawal_discovery
    WHERE source_id=$1 AND claims_key=$2 AND updated_at > now() - interval '1 hour'`, [sourceId, key]);
  // Incarnation moved under a retained plan: the scan's coverage is bound to
  // the replaced source, so it resets rather than resuming stale state (the
  // stale row is overwritten by the next persist or removed on completion).
  const plan = stored[0] && stored[0].source_incarnation === source.incarnation ? stored[0] : null;
  const affected = new Set<number>(plan?.affected ?? []);
  let phase: ScanPhase = plan && (PHASES as readonly string[]).includes(plan.phase) ? plan.phase : 'facts';
  let cursor = plan ? Number(plan.cursor) : 0;
  // In-invocation drift cursor: (window timestamp, row id) per drift stream.
  // Drift windows are non-monotonic — a row enters one by being updated — so
  // the persisted cursor is always 0 for drift phases and each resumed drift
  // phase rescans its whole bounded window.
  const driftAt: Record<'drift_pages' | 'drift_chunks' | 'drift_facts', { ts: string; id: number }> = {
    drift_pages: { ts: '', id: 0 },
    drift_chunks: { ts: '', id: 0 },
    drift_facts: { ts: '', id: 0 },
  };
  // started_at binds the drift window to this plan's beginning: any row whose
  // timestamp advanced since is rescanned, whatever the caller's clock says.
  const [now] = await engine.executeRaw<{ now: string }>('SELECT now()::text AS now');
  const startedAt = plan?.started_at ?? now.now;
  driftAt.drift_pages.ts = startedAt;
  driftAt.drift_chunks.ts = startedAt;
  driftAt.drift_facts.ts = startedAt;
  const pendingPlan = (): PendingPlan => ({
    source_id: sourceId, claims_key: key, claims: claimsJson, source_incarnation: source.incarnation,
    phase, cursor: DRIFT_PHASES.has(phase) ? 0 : cursor, affected: [...affected], started_at: startedAt,
  });

  const match = async (incoming: Array<{ id: number; claim: string; visibility: string | null; ambiguous: boolean }>) => {
    if (!incoming.length) return;
    if (incoming.length > 16_384 || Buffer.byteLength(JSON.stringify(incoming)) > 8 * 1024 * 1024) refuse();
    const matches = await engine.executeRaw<{ id: number; ambiguous: boolean }>(`SELECT DISTINCT i.id,i.ambiguous
      FROM jsonb_to_recordset($1::text::jsonb) i(id integer,claim text,visibility text,ambiguous boolean)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text)
        ON (i.visibility IS NULL OR i.visibility=w.visibility) AND gbrain_fact_fingerprint(i.claim)=w.fact_hash`, [JSON.stringify(incoming), claimsJson]);
    if (matches.some(row => row.ambiguous)) refuse('withdrawal_provenance');
    for (const row of matches) affected.add(row.id);
    if (affected.size > WITHDRAWAL_LIMITS.targets) refuse();
  };
  const provenance = async (rows: ScanRow[]) => {
    const found = await engine.executeRaw<{ id: number }>(`SELECT DISTINCT p.id FROM facts f
      JOIN pages p ON p.source_id=f.source_id AND p.slug=COALESCE(f.source_markdown_slug,f.entity_slug)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text)
        ON w.visibility=f.visibility AND w.fact_hash=gbrain_fact_fingerprint(f.fact)
      JOIN jsonb_to_recordset($3::text::jsonb) fid(id bigint) ON f.id=fid.id
      WHERE f.source_id=$1`, [sourceId, claimsJson, JSON.stringify(rows.map(row => ({ id: Number(row.id) })))]);
    for (const row of found) affected.add(row.id);
    if (affected.size > WITHDRAWAL_LIMITS.targets) refuse();
  };
  const handlers: Record<ScanPhase, (rows: ScanRow[]) => Promise<void>> = {
    facts: provenance,
    drift_facts: provenance,
    pages: rows => match(rows.flatMap(row => pageIncoming(row as { id: number; compiled_truth: string; timeline: string }))),
    drift_pages: rows => match(rows.flatMap(row => pageIncoming(row as { id: number; compiled_truth: string; timeline: string }))),
    chunks: rows => match(rows.flatMap(row => chunkIncoming(row as { id: number; page_id: number; chunk_text: string }))),
    drift_chunks: rows => match(rows.flatMap(row => chunkIncoming(row as { id: number; page_id: number; chunk_text: string }))),
  };

  const fetchers: Record<ScanPhase, () => Promise<ScanRow[]>> = {
    facts: () => engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND id>$2 ORDER BY id LIMIT $3', [sourceId, cursor, batch]),
    pages: () => engine.executeRaw('SELECT id,compiled_truth,timeline FROM pages WHERE source_id=$1 AND id>$2 ORDER BY id LIMIT $3', [sourceId, cursor, batch]),
    chunks: () => engine.executeRaw('SELECT c.id,c.page_id,c.chunk_text FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND c.id>$2 ORDER BY c.id LIMIT $3', [sourceId, cursor, batch]),
    // Drift tuple params bind as text and cast server-side: a timestamptz
    // param would serialize through JS Date and lose the microseconds the
    // ::text projection carries, re-matching the cursor row forever.
    drift_pages: () => engine.executeRaw(`SELECT id,compiled_truth,timeline,updated_at::text AS drift_ts FROM pages
      WHERE source_id=$1 AND updated_at>$2::text::timestamptz AND (updated_at,id) > ($3::text::timestamptz,$4::int)
      ORDER BY updated_at,id LIMIT $5`, [sourceId, startedAt, driftAt.drift_pages.ts, driftAt.drift_pages.id, batch]),
    drift_chunks: () => engine.executeRaw(`SELECT c.id,c.page_id,c.chunk_text,p.updated_at::text AS drift_ts FROM content_chunks c JOIN pages p ON p.id=c.page_id
      WHERE p.source_id=$1 AND p.updated_at>$2::text::timestamptz AND (p.updated_at,c.id) > ($3::text::timestamptz,$4::int)
      ORDER BY p.updated_at,c.id LIMIT $5`, [sourceId, startedAt, driftAt.drift_chunks.ts, driftAt.drift_chunks.id, batch]),
    drift_facts: () => engine.executeRaw(`SELECT id,created_at::text AS drift_ts FROM facts
      WHERE source_id=$1 AND created_at>$2::text::timestamptz AND (created_at,id) > ($3::text::timestamptz,$4::bigint)
      ORDER BY created_at,id LIMIT $5`, [sourceId, startedAt, driftAt.drift_facts.ts, driftAt.drift_facts.id, batch]),
  };
  while (true) {
    const rows = await fetchers[phase]();
    if (!rows.length) {
      const next = PHASES[PHASES.indexOf(phase) + 1];
      if (!next) break;
      phase = next;
      cursor = 0;
      continue;
    }
    await handlers[phase](rows);
    const last = rows[rows.length - 1];
    if (DRIFT_PHASES.has(phase)) driftAt[phase as 'drift_pages' | 'drift_chunks' | 'drift_facts'] = { ts: last.drift_ts!, id: Number(last.id) };
    else cursor = Number(last.id);
    // Checked after each batch so every invocation commits ≥1 batch of
    // progress — a pending receipt always advances the retained cursor.
    if (performance.now() > deadline) pending(pendingPlan());
  }

  if (affected.size > WITHDRAWAL_LIMITS.targets) refuse();
  const targets = await engine.executeRaw<WithdrawalTarget>('SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, [...affected]]);
  // Final coverage probe — the last read before commit. Every drift fetcher
  // must come back empty at its last-seen tuple; a row that moved into a
  // window during the scan suspends the commit instead of shipping an
  // unproven target set.
  for (const p of ['drift_pages', 'drift_chunks', 'drift_facts'] as const) {
    if ((await fetchers[p]()).length) pending({ ...pendingPlan(), phase: p });
  }
  if (Buffer.byteLength(JSON.stringify(targets)) > WITHDRAWAL_LIMITS.targetBytes) refuse();
  await engine.executeRaw('DELETE FROM fact_withdrawal_discovery WHERE source_id=$1 AND claims_key=$2', [sourceId, key]);
  return targets.sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

export function withdrawalDiscoveryFailure(error: unknown): never {
  if (getCode(error) === '57014') refuse();
  throw error;
}
