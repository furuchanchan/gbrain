import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { recordFailures } from '../src/core/sync-failure-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

// gbrain#5452 — failures on an archived source cannot be cleared (sync
// refuses archived sources) and carry no live signal; doctor's
// sync_failures check must exclude them and say so.
const home = mkdtempSync(join(tmpdir(), 'gbrain-5452-'));
const env = { GBRAIN_SYNC_FAILURES_DIR: home };

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('TRUNCATE sources CASCADE');
  rmSync(join(home, 'sync-failures.jsonl'), { force: true });
});

describe('sync_failures ignores archived-source rows (#5452)', () => {
  test('failures on an archived source are excluded and reported as ignored', async () => withEnv(env, async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('src-active','src-active'),('src-archived','src-archived')`);
    await engine.executeRaw(`UPDATE sources SET archived=true, archived_at=now(), archive_expires_at=now()+interval '72 hours' WHERE id='src-archived'`);
    recordFailures('src-active', [{ path: 'a.md', error: 'YAML broke' }], 'c1');
    recordFailures('src-archived', [{ path: 'b.md', error: 'YAML broke' }], 'c2');

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check).not.toBeNull();
    expect(check!.status).not.toBe('ok');
    expect(check!.message).toContain('1 unresolved');
    expect(check!.message).toContain('1 on archived source(s) ignored');
    expect(check!.message).toContain('src-active');
    expect(check!.message).not.toContain('src-archived');
  }));

  test('only-archived failures resolve to ok, not an unclearable fail', async () => withEnv(env, async () => {
    await engine.executeRaw(`INSERT INTO sources(id,name) VALUES('src-archived','src-archived')`);
    await engine.executeRaw(`UPDATE sources SET archived=true, archived_at=now(), archive_expires_at=now()+interval '72 hours' WHERE id='src-archived'`);
    recordFailures('src-archived', [{ path: 'b.md', error: 'YAML broke' }], 'c2');

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check?.status).toBe('ok');
    expect(check!.message).toContain('archived-source failure(s) ignored');
  }));
});
