/**
 * Settles queued embedding effects that have nothing left to do, in bulk.
 *
 * A classic import followed by `gbrain embed --stale` (or a restored or moved
 * brain) can leave tens of thousands of queued page embedding effects whose
 * chunks already carry current vectors. Each one would otherwise take a claim,
 * a guard transaction, a projection read and a completion update before
 * reaching the outcome the effect runner records when nothing is pending.
 *
 * An effect is settled here only when the runner would find nothing to embed:
 * a plain page effect (no targets, scan, retry slugs or parked targets) never
 * attempted, ready and claimable by this host as `claimPersistenceEffect`
 * would claim it, whose source passes `guardEffectSource`, whose page is live
 * at the effect's revision with its text projection sealed there, and whose
 * every chunk passes `readEmbeddingEffectProjection`'s completion test for the
 * current signature, write column and model. The row ends exactly as the
 * runner's own claim and completion leave it (state, outcome, attempts,
 * cleared claim). Every other effect is left for the runner.
 *
 * No effect kind is ordered after a page embedding effect: the claim order is
 * `next_attempt_at, id` across kinds, only Git groups and withdrawal mirrors
 * gate other effects, and an embedding effect gates nothing.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { embeddingWriteTarget } from '../page-state/projections.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { guardEffectSource } from './effect-recovery.ts';
import type { PersistenceEffect } from './effect-model.ts';
import { faultPoint } from './fault-points.ts';
import { declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { refreshFenceClear } from './worktree-refresh-schema.ts';

/** At most this many effects settle in one statement. */
export const NOOP_SETTLE_BATCH = 200;

/** Guard failures that leave an effect for the runner, which records them as it does today. */
const LEFT_FOR_RUNNER = new Set(['owner_unavailable', 'source_changed', 'recovery_required']);

type Candidate = Pick<PersistenceEffect, 'id' | 'kind' | 'source_id' | 'source_incarnation' | 'worktree_id'>;

/** Settles up to `limit` no-op embedding effects claimable by `hostId`; resolves with how many it settled. */
export async function settleNoopEmbeddingEffects(engine: BrainEngine, hostId: string, signature: string, limit = NOOP_SETTLE_BATCH): Promise<number> {
  // Most drains have no unattempted embedding effect at all: one indexed probe, no transaction.
  const [due] = await engine.executeRaw(`SELECT 1 FROM persistence_effects WHERE kind='embedding' AND state='queued' AND attempts=0
    AND next_attempt_at<=now() AND recovery IS NULL LIMIT 1`);
  if (!due) return 0;
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    const { column, model } = await embeddingWriteTarget(tx);
    const expectedModel = column.name === 'embedding' ? signature.slice(0, signature.lastIndexOf(':')) : column.embeddingModel ?? model;
    const vector = quoteIdentifier(column.name);
    const candidates = await tx.executeRaw<Candidate>(`SELECT e.id, e.kind, e.source_id, e.source_incarnation, e.worktree_id
      FROM persistence_effects e
      LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
      JOIN pages p ON p.id=(e.data->>'page_id')::int AND p.source_id=e.source_id
      WHERE e.kind='embedding' AND e.state='queued' AND e.attempts=0 AND e.next_attempt_at<=now() AND e.recovery IS NULL
        AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'retry_slugs') AND NOT (e.data ? 'parked')
        AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR ${refreshFenceClear('e')})
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
          WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')
        AND p.deleted_at IS NULL AND p.knowledge_revision=e.revision AND p.text_projection_revision=p.knowledge_revision
        AND p.embedding_signature=$2
        AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id=p.id AND NOT (cc.${vector} IS NOT NULL
          AND cc.embedded_at IS NOT NULL AND cc.embedded_text_hash IS NOT DISTINCT FROM md5(cc.chunk_text) AND cc.model IS NOT DISTINCT FROM $3))
      ORDER BY e.next_attempt_at, e.id LIMIT $4
      FOR UPDATE OF e SKIP LOCKED FOR SHARE OF p`, [hostId, signature, expectedModel, limit]);
    if (!candidates.length) return 0;
    const guarded = new Map<string, boolean>();
    const ids: string[] = [];
    for (const effect of candidates) {
      const key = `${effect.source_id}\0${effect.source_incarnation}\0${effect.worktree_id ?? ''}`;
      if (!guarded.has(key)) {
        guarded.set(key, await guardEffectSource(tx, effect as PersistenceEffect, hostId).then(() => true, error => {
          if (error instanceof OperationError && LEFT_FOR_RUNNER.has(error.code)) return false;
          throw error;
        }));
      }
      if (guarded.get(key)) ids.push(String(effect.id));
    }
    if (!ids.length) return 0;
    const settled = await tx.executeRaw(`UPDATE persistence_effects SET state='committed', error_code=NULL, attempts=attempts+1,
        data=data-'retry_slugs'-'target_failures'-'failing_target', execution_token=NULL, claim_expires_at=NULL, outcome='{}'::jsonb, updated_at=now()
      WHERE id=ANY($1::text[]::bigint[]) AND state='queued' AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [ids]);
    await faultPoint('effect:embedding:settle', { effectId: ids[0] });
    return settled.length;
  });
}
