import type { BrainEngine } from '../engine.ts';
import { topologyTransaction } from './topology-transaction.ts';
import { withCoordinatedWrite } from './context.ts';

/**
 * Managed-brain variant of the tombstone sweep. The managed writer-guard
 * trigger refuses the raw `DELETE FROM pages`, so each source's expired
 * tombstones are reaped inside the canonical coordinated write — one bounded
 * topology transaction per source, the same route the source-lifecycle
 * 'purge' operation uses. Callers decide managed-ness; this function assumes
 * persistence_brain.enabled = true.
 */
export async function purgeDeletedPagesManaged(
  engine: BrainEngine,
  hours: number,
): Promise<{ slugs: string[]; count: number }> {
  const groups = await engine.executeRaw<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM pages
     WHERE deleted_at IS NOT NULL
       AND deleted_at < now() - ($1 || ' hours')::interval
     ORDER BY source_id`,
    [hours],
  );
  const slugs: string[] = [];
  for (const group of groups) {
    await topologyTransaction(engine, async (tx) => {
      await withCoordinatedWrite(tx, [group.source_id], async () => {
        const rows = await tx.executeRaw<{ slug: string }>(
          `DELETE FROM pages
           WHERE source_id = $1
             AND deleted_at IS NOT NULL
             AND deleted_at < now() - ($2 || ' hours')::interval
           RETURNING slug`,
          [group.source_id, hours],
        );
        slugs.push(...rows.map((r) => r.slug));
      });
    });
  }
  return { slugs, count: slugs.length };
}
