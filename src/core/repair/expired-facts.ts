/**
 * `gbrain repair expired-facts` (#5731, remaining scope): re-activate
 * `cli:extract-conversation-facts` facts the canonical projection wrongly
 * expired before the fenceless-page fix. The projection treated a page with
 * no `## Facts` fence as an empty fence and stamped `expired_at` +
 * `row_num = NULL` on every extractor row — those rows are never
 * fence-owned, so that signature is damage, not intent.
 *
 * Two expiry paths can produce the same `expired_at` + `row_num IS NULL`
 * signature and are kept, not restored: an explicit `forget` leaves a
 * matching `fact_withdrawals` row (the durable record that protects the
 * retraction), and a DB-only supersession sets `superseded_by` (the update
 * never touches `row_num`, which the projection may already have cleared).
 * `cli:` producers outside `cli:extract-conversation-facts%` (think, takes
 * bootstrap, transcript ingest) write no facts rows and stay out of scope.
 * Bookkeeping only: no page write and no journal admission.
 */
import type { BrainEngine } from '../engine.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import type { RepairHandler, RepairItem } from './core.ts';

/**
 * A fact_withdrawals row covers the fact when the claim fingerprint matches
 * and the recorded subject either withdraws source-wide ('*', a subjectless
 * withdrawal) or names the fact's own entity — the same subject scope
 * `recordFactWithdrawal` writes.
 */
const WITHDRAWAL_GUARD = `
  AND NOT EXISTS (
    SELECT 1 FROM fact_withdrawals w
    WHERE w.source_id = f.source_id
      AND w.visibility = f.visibility
      AND (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*'))
      AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
  )`;

const VICTIM_PREDICATE = `
  f.source LIKE 'cli:extract-conversation-facts%'
  AND f.expired_at IS NOT NULL
  AND f.row_num IS NULL
  AND f.superseded_by IS NULL${WITHDRAWAL_GUARD}`;

export const expiredFactsRepair: RepairHandler = {
  kind: 'expired-facts',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after) {
    const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string | null; expired_at: string }>(
      `SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.expired_at::text AS expired_at
       FROM facts f
       WHERE ${VICTIM_PREDICATE} AND f.source_id = ANY($1::text[])
         AND ($2::int IS NULL OR f.id > $2)
       ORDER BY f.id`,
      [scope.source_ids, after?.id ?? null],
    );
    const items: RepairItem[] = rows.map(row => ({
      cursor: { phase: 0, id: row.id },
      source_id: row.source_id,
      slug: row.slug ?? `fact:${row.id}`,
      chars: 0,
      action: 'unexpire',
      change: { from: JSON.stringify({ id: row.id, expired_at: row.expired_at }), to: 'active' },
    }));
    const kept = await engine.executeRaw<{ withdrawn: number; superseded: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE w.fact_hash IS NOT NULL)::int AS withdrawn,
         COUNT(*) FILTER (WHERE w.fact_hash IS NULL AND f.superseded_by IS NOT NULL)::int AS superseded
       FROM facts f
       LEFT JOIN LATERAL (
         SELECT w.fact_hash FROM fact_withdrawals w
         WHERE w.source_id = f.source_id
           AND w.visibility = f.visibility
           AND (w.subject = '*' OR w.subject = COALESCE(f.entity_slug, '*'))
           AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
         LIMIT 1
       ) w ON true
       WHERE f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NOT NULL
         AND f.source_id = ANY($1::text[])
         AND (w.fact_hash IS NOT NULL OR f.superseded_by IS NOT NULL)`,
      [scope.source_ids],
    );
    const residuals: Record<string, number> = {};
    if (kept[0]) {
      if (kept[0].withdrawn > 0) residuals.withdrawn_kept = kept[0].withdrawn;
      if (kept[0].superseded > 0) residuals.superseded_kept = kept[0].superseded;
    }
    return { items, residuals };
  },
  async apply(ctx, item) {
    const { id } = JSON.parse(item.change!.from!) as { id: number };
    const restore = (engine: BrainEngine) => engine.executeRaw<{ id: number }>(
      `UPDATE facts f SET expired_at = NULL
       WHERE f.id = $1 AND ${VICTIM_PREDICATE} RETURNING f.id`,
      [id],
    );
    // `facts` carries managed_writer_guard: when persistence is enabled an
    // UPDATE outside the canonical writer's gbrain.write_sources grant is
    // refused. Enter the coordinated-write capability for the single
    // statement, the same way maintenance writes do. Unmanaged brains have
    // no armed trigger and need no grant.
    const [brain] = await ctx.engine.executeRaw<{ enabled: boolean }>(
      'SELECT enabled FROM persistence_brain WHERE singleton = 1',
    ).catch(() => []);
    // One transaction per item: the sources FOR UPDATE lock serializes this
    // recheck against a concurrent forget (recordFactWithdrawal takes the
    // same lock), so a withdrawal committed between preview and apply wins
    // and the re-activation skips.
    const restored = await ctx.engine.transaction(async tx => {
      await tx.executeRaw('SELECT id FROM sources WHERE id = $1 FOR UPDATE', [item.source_id]);
      return brain?.enabled ? withCoordinatedWrite(tx, [item.source_id], () => restore(tx)) : restore(tx);
    });
    return { applied: restored.length === 1, outcome: restored.length === 1 ? 'restored' : 'settled' };
  },
};
