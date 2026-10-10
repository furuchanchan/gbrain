/**
 * #6318: the reads that bypass `executeRaw` inside `withScopedReadTransaction`
 * (the page snapshot read, the batch read, the import pipeline's content-hash
 * lookup `findDuplicatePage`) now carry `timeoutMs` as a transaction-local
 * `SET LOCAL statement_timeout`. A read parked on `Lock/relation` past its
 * budget ends server-side with SQLSTATE 57014, freeing the pinned connection —
 * for every member, not just the head.
 *
 * Runs only when DATABASE_URL points at a scratch Postgres (the backends
 * matrix's postgres arm). Each test holds `pages` under ACCESS EXCLUSIVE on an
 * independent connection and proves the bounded read fails fast instead of
 * waiting out the lock — on master the same call blocks until the lock is
 * released, so the test is discriminating either way.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

let engine: PostgresEngine | undefined;
let databaseUrl = '';
let closePostgres: (() => Promise<void>) | undefined;
const SOURCE = 'bounded-6318';

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
  engine = pg.engine; closePostgres = pg.close; databaseUrl = pg.databaseUrl;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [SOURCE, '/brain']);
  await engine.putPage('notes/held', { type: 'note', title: 'Held', compiled_truth: 'bounded-read marker', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
}, 120_000);

afterAll(async () => {
  if (engine) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [SOURCE]);
  await closePostgres?.();
});

/** Hold `pages` exclusively on an independent connection until released. */
async function holdPagesLock() {
  const blocker = postgres(databaseUrl, { max: 1, prepare: false });
  let release!: () => void;
  const lockHeld = new Promise<void>(resolve => { release = resolve; });
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const locked = blocker.begin(async sql => {
    await sql`LOCK TABLE pages IN ACCESS EXCLUSIVE MODE`;
    acquired();
    await lockHeld;
  });
  await ready;
  return { release: async () => { release(); await locked; await blocker.end(); } };
}

for (const [name, read] of [
  ['readPageSnapshot', (e: PostgresEngine, timeoutMs: number) => e.readPageSnapshot('notes/held', { sourceId: SOURCE, timeoutMs })],
  ['getPage', (e: PostgresEngine, timeoutMs: number) => e.getPage('notes/held', { sourceId: SOURCE, timeoutMs })],
  ['readPageSnapshotsBatch', (e: PostgresEngine, timeoutMs: number) => e.readPageSnapshotsBatch([{ slug: 'notes/held', sourceId: SOURCE }], { timeoutMs })],
  ['findDuplicatePage', (e: PostgresEngine, timeoutMs: number) => e.findDuplicatePage(SOURCE, { hash: 'content-hash-marker', timeoutMs })],
] as const) {
  test(`${name} parked on Lock/relation ends at the bound (57014), never at the lock`, async () => {
    if (!engine) return;
    const lock = await holdPagesLock();
    try {
      const started = Date.now();
      const outcome = await Promise.race([
        read(engine, 500).then(value => ({ value }), error => ({ error })),
        // Past 10 s the lock is released rather than leaving the test hung (master blocks here).
        new Promise<{ timeout: true }>(resolve => setTimeout(() => resolve({ timeout: true }), 10_000)),
      ]);
      const elapsed = Date.now() - started;
      expect('error' in outcome && (outcome.error as { code?: string }).code).toBe('57014');
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await lock.release();
    }
  }, 30_000);
}
