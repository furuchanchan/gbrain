/**
 * #5087: ops that declare their own `source` parameter own --source on the
 * local CLI route — it is the op's argument, never the scope flag.
 *
 * Before the fix, `makeContext` resolved `params.source` through the scope
 * tiers for EVERY op, so `gbrain timeline-add <slug> <date> <summary>
 * --source meetings/2026-04-03` died in source resolution (`Invalid
 * --source value ... Must match [a-z0-9-]{1,32}.` or "Source ... not
 * found") and a valid source-id-shaped provenance was silently consumed as
 * scope with the entry written under empty provenance. The thin-client
 * path already exempted these ops (applyThinClientSourceScope's early
 * return); `paramsForContextBuild` masks the flag for the local context
 * build the same way while `op.handler` still receives the untouched
 * params.
 *
 * The acceptance signal is the issue's own control case: on a nonexistent
 * page the command must now reach the op and fail `page_not_found` — the
 * source-shape error must NOT fire.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeContext } from '../src/cli.ts';
import { paramsForContextBuild } from '../src/cli/source-scope.ts';
import { operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-5087-'));
  engine = new PGLiteEngine();
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    await engine.connect({});
    await engine.initSchema();
  });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('#5087 — paramsForContextBuild', () => {
  test('masks source only for ops that declare it; other params pass through', () => {
    const timeline = operationsByName.add_timeline_entry;
    expect('source' in timeline.params).toBe(true);
    const params = { slug: 'x', date: '2026-09-14', summary: 's', source: 'meetings/2026-04-03', dry_run: true };
    const masked = paramsForContextBuild(timeline, params);
    expect(masked.source).toBeUndefined();
    expect(masked.slug).toBe('x');
    expect(masked.dry_run).toBe(true);
    // The op's own view is untouched — op.handler receives the original params.
    expect(params.source).toBe('meetings/2026-04-03');
  });

  test('ontology_propose (the other source-declaring CLI op) is masked the same', () => {
    const op = operationsByName.ontology_propose;
    expect('source' in op.params).toBe(true);
    expect(paramsForContextBuild(op, { source: 'capture-2026-09' }).source).toBeUndefined();
  });

  test('ops without a source param get the same object back (no masking)', () => {
    const query = operationsByName.query;
    expect('source' in query.params).toBe(false);
    const params = { query: 'x', source: 'bogus-shape!' };
    expect(paramsForContextBuild(query, params)).toBe(params);
  });
});

describe('#5087 — local route reaches the op with provenance intact', () => {
  test('timeline-add --source <ref> fails page_not_found, not source-shape', async () => {
    const op = operationsByName.add_timeline_entry;
    const params = { slug: 'zz-nonexistent-probe', date: '2026-09-14', summary: 'probe', source: 'meetings/2026-04-03' };
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined }, async () => {
      const ctx = await makeContext(engine, paramsForContextBuild(op, params));
      expect(ctx.sourceId).toBe('default');
      // The flag reached the op: the handler looks up the page and reports
      // page_not_found — the pre-fix run died in scope resolution first.
      await expect(op.handler(ctx, params)).rejects.toThrow(/page_not_found|not found in writable source/i);
    });
    expect(params.source).toBe('meetings/2026-04-03');
  });

  test('a source-id-shaped provenance is NOT consumed as scope', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('meeting-2026-04-03', 'meeting-2026-04-03', false)`,
    );
    const op = operationsByName.add_timeline_entry;
    const params = { slug: 'zz-nonexistent-probe', date: '2026-09-14', summary: 'probe', source: 'meeting-2026-04-03' };
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined }, async () => {
      const ctx = await makeContext(engine, paramsForContextBuild(op, params));
      // Scope resolution must not have consumed the provenance ref as the
      // flag tier — the context resolves to the seed default.
      expect(ctx.sourceId).toBe('default');
      await expect(op.handler(ctx, params)).rejects.toThrow(/page_not_found|not found in writable source/i);
    });
    expect(params.source).toBe('meeting-2026-04-03');
  });

  test('scope flag still applies to ops that do NOT declare source (#1712 stays fail-closed)', async () => {
    const query = operationsByName.query;
    await expect(
      makeContext(engine, paramsForContextBuild(query, { query: 'x', source: 'bogus-shape!' })),
    ).rejects.toThrow(/Must match/);
  });
});

describe('#5087 — real CLI dispatch (the issue\'s own repro)', () => {
  test('gbrain timeline-add --source <slug> reaches the op: page_not_found, not Invalid --source', async () => {
    const cliHome = mkdtempSync(join(tmpdir(), 'gbrain-5087-cli-'));
    try {
      const init = await runCli(['init', '--pglite', '--no-embedding', '--non-interactive'], { home: cliHome, timeoutMs: 120_000 });
      expect(init.exitCode).toBe(0);

      const res = await runCli(
        ['timeline-add', 'zz-nonexistent-probe', '2026-09-14', 'probe', '--source', 'meetings/2026-04-03'],
        { home: cliHome, timeoutMs: 90_000 },
      );
      // The flag reached the op: dispatch proceeded to the handler, which
      // reports the missing page. Pre-fix this died in scope resolution with
      // `Invalid --source value "meetings/2026-04-03". Must match [a-z0-9-]{1,32}.`
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toMatch(/page_not_found|not found in writable source/i);
      expect(res.stderr).not.toMatch(/Invalid --source value/);
      expect(res.stderr).not.toMatch(/not found or is archived/i);
    } finally {
      rmSync(cliHome, { recursive: true, force: true });
    }
  }, 180_000);
});
