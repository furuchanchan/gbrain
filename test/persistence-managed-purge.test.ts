/**
 * #5405 — on a managed brain, `purgeDeletedPages`'s raw DELETE is refused by
 * the managed writer-guard trigger, so `gbrain dream --phase purge` (and the
 * `pages purge-deleted` command that shares the library call) fails every
 * run and tombstones accumulate forever. The sweep must route each source's
 * expired tombstones through the canonical coordinated write instead.
 *
 * Pins: managed brain → purgeDeletedPages reaps via the coordinator (same
 * result shape), unmanaged → the raw sweep path is unchanged, dry-run still
 * previews without deleting on either mode.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'managed-purge-test';

const input = (body: string) => ({
  type: 'note',
  title: 'Managed purge',
  compiled_truth: body,
  timeline: '',
  frontmatter: {},
});

beforeAll(async () => {
  const pg = process.env.DATABASE_URL;
  const local = new PGLiteEngine();
  await local.connect({});
  await local.initSchema();
  engines.push(local);
  if (pg) {
    assertSafeE2eDatabaseUrl(pg);
    const isolated = await isolatedPersistencePostgres(pg);
    closePostgres = isolated.close;
    engines.push(isolated.engine);
  }
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.disconnect();
  }
  await closePostgres?.();
});

async function seedDeletedPage(engine: BrainEngine, slug: string): Promise<void> {
  await engine.transaction((tx) =>
    withCoordinatedWrite(tx, [sourceId], async () => {
      await tx.putPage(slug, input(`body for ${slug}`), { sourceId });
      await tx.softDeletePage(slug, { sourceId });
    }),
  );
  // Push the tombstone past any positive TTL by writing deleted_at directly —
  // inside the same coordinated write, since UPDATE on pages is also guarded.
  await engine.transaction((tx) =>
    withCoordinatedWrite(tx, [sourceId], () =>
      tx.executeRaw(
        `UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug = $1 AND source_id = $2`,
        [slug, sourceId],
      ),
    ),
  );
}

describe('managed brain — purgeDeletedPages (#5405)', () => {
  test('unmanaged sweep still reaps through the raw path', async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await seedDeletedPage(engine, 'unmanaged/expired');
      const result = await engine.purgeDeletedPages(72);
      expect(result.slugs).toContain('unmanaged/expired');
      await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [sourceId]);
    }
  });

  test('managed sweep reaps tombstones via the coordinator instead of failing', async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        // The guard is real: an uncoordinated write is still refused.
        await expect(
          engine.putPage('unguarded', input('No'), { sourceId }),
        ).rejects.toThrow('writer_coordinator_required');
        await seedDeletedPage(engine, 'managed/expired-a');
        await seedDeletedPage(engine, 'managed/expired-b');
        const preview = await engine.purgeDeletedPages(72, { dryRun: true });
        expect(preview.slugs).toContain('managed/expired-a');
        expect(preview.slugs).toContain('managed/expired-b');
        const result = await engine.purgeDeletedPages(72);
        expect(result.slugs.sort()).toEqual(['managed/expired-a', 'managed/expired-b']);
        const remaining = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM pages WHERE source_id = $1`,
          [sourceId],
        );
        expect(remaining[0]?.n).toBe(0);
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [sourceId]);
      }
    }
  });

  test('managed sweep leaves unexpired tombstones alone', async () => {
    for (const engine of engines) {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await engine.transaction((tx) =>
          withCoordinatedWrite(tx, [sourceId], async () => {
            await tx.putPage('managed/fresh', input('still young'), { sourceId });
            await tx.softDeletePage('managed/fresh', { sourceId });
          }),
        );
        const result = await engine.purgeDeletedPages(72);
        expect(result.slugs).not.toContain('managed/fresh');
        const remaining = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM pages WHERE slug = 'managed/fresh' AND source_id = $1`,
          [sourceId],
        );
        expect(remaining[0]?.n).toBe(1);
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('DELETE FROM pages WHERE source_id = $1', [sourceId]);
      }
    }
  });
});
