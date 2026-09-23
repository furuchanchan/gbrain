/**
 * doctor/checks/managed-sync-wedge.ts — `managed_sync_wedge`: is a durable
 * managed-sync cursor frozen on a terminal write receipt?
 *
 * #5353: one unimportable file pins the managed cursor at its commit
 * permanently — every later incremental `gbrain sync` replays
 * `blocked_by_failures` against the same frozen pending request
 * (sync-run.ts: `done.state !== 'committed'` returns the same outcome until
 * `--retry-failed` rebuilds the cursor), while `sync_freshness` stays green
 * because it measures commit lag, not cursor liveness.
 *
 * The wedge is the durable join, not the receipt alone: a terminal
 * persistence_request only wedges when an op_checkpoints managed-sync
 * cursor's `pending.requestId` still points at it. Retried receipts
 * (`--retry-failed` re-enumerates a fresh cursor and request) are orphans
 * and correctly excluded; so are compacted receipts (`intent=NULL`) and
 * in-flight non-terminal states (writer_pending resumes itself).
 *
 * Pure DB read — safe on both surfaces; remote renders aggregate counts
 * only (a receipt path is local-owner detail, the same amendment-29
 * discipline as backup_coverage).
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

export async function checkManagedSyncWedge(
  engine: BrainEngine,
  opts: { remote?: boolean } = {},
): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{
      source_id: string;
      slug: string;
      state: string;
      error_code: string | null;
      path: string | null;
      updated_at: Date;
    }>(
      `SELECT pr.source_id, pr.slug, pr.state, pr.error_code,
              pr.intent->>'path' AS path, pr.updated_at
       FROM op_checkpoints ck
       JOIN persistence_requests pr
         ON pr.request_id = (ck.completed_keys->0->'pending'->>'requestId')::uuid
       WHERE ck.op = 'managed-sync'
         AND ck.completed_keys->0->'pending'->>'requestId' IS NOT NULL
         AND pr.state IN ('failed','conflict','cancelled')
       ORDER BY pr.updated_at ASC
       LIMIT 50`,
    );

    if (rows.length === 0) {
      return { name: 'managed_sync_wedge', status: 'ok', message: 'No durable sync cursor frozen on a failed write' };
    }

    const sources = new Set(rows.map((r) => r.source_id));
    if (opts.remote) {
      return {
        name: 'managed_sync_wedge',
        status: 'fail',
        message:
          `${rows.length} terminal managed sync write(s) freeze ${sources.size} durable sync cursor(s) — ` +
          'incremental sync replays `blocked_by_failures` while `sync_freshness` stays green. ' +
          'Run `gbrain doctor` on the brain host for the per-file detail and repair command.',
        details: { wedged_writes: rows.length, wedged_sources: sources.size, note: 'aggregate counts only (remote surface)' },
      };
    }

    const list = rows
      .slice(0, 5)
      .map((r) => `${r.path ?? r.slug} [${r.source_id}] (${r.state}${r.error_code ? `: ${r.error_code}` : ''})`)
      .join(', ');
    return {
      name: 'managed_sync_wedge',
      status: 'fail',
      message:
        `${rows.length} terminal managed sync write(s) freeze durable sync cursor(s) — ` +
        `incremental sync replays \`blocked_by_failures\` while \`sync_freshness\` stays green: ${list}. ` +
        'Repair: fix the failing file, then `gbrain sync --source <id> --retry-failed` ' +
        '(re-enumerates a fresh cursor; `--skip-failed` cannot bypass a managed write).',
      details: {
        wedged_writes: rows.length,
        wedged_sources: sources.size,
        rows: rows.map((r) => ({
          source_id: r.source_id, slug: r.slug, path: r.path,
          state: r.state, error_code: r.error_code, updated_at: r.updated_at,
        })),
      },
    };
  } catch {
    // A pre-persistence brain has no op_checkpoints/persistence_requests —
    // unreadable here means "nothing to freeze on", not a wedge.
    return { name: 'managed_sync_wedge', status: 'ok', message: 'persistence ledger unreadable (pre-managed-persistence brain?)' };
  }
}
