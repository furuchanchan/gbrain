/**
 * #4653 — the schema inspection verbs (show / explain / graph / lint) must
 * resolve the active pack through the same tier chain `schema active` uses,
 * including tier 4 (brain-wide DB config `schema_pack`).
 *
 * Serial because it opens a persistent PGLite database and then hands that
 * database to CLI subprocesses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const REPO_ROOT = join(import.meta.dir, '..');

let home: string;

function runSchema(...args: string[]) {
  return spawnSync('bun', ['run', 'src/cli.ts', 'schema', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GBRAIN_DATABASE_URL: '',
      DATABASE_URL: '',
      GBRAIN_SCHEMA_PACK: '',
      GBRAIN_HOME: home,
    },
    timeout: 60_000,
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-db-config-'));
  const gbrainDir = join(home, '.gbrain');
  const dbPath = join(gbrainDir, 'brain.pglite');
  mkdirSync(gbrainDir, { recursive: true });
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    // Tier 4 only: no env var, no config.json schema_pack.
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
    // Tier 3 per-source override for `wiki` only (#6090).
    await engine.setConfig('schema_pack.source.wiki', 'gbrain-base');
  } finally {
    await engine.disconnect();
  }
  writeFileSync(
    join(gbrainDir, 'config.json'),
    JSON.stringify({ engine: 'pglite', database_path: dbPath }),
    'utf-8',
  );
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('#6090 schema active --source resolves the per-source pack', () => {
  test('--source <id> reports the per-source override', () => {
    const r = runSchema('active', '--source', 'wiki');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Active pack for source 'wiki': gbrain-base ");
    expect(r.stdout).toContain('Source: per-source-db');
  }, 90_000);

  test('--source <id> with no override falls back to the brain pack', () => {
    const r = runSchema('active', '--source', 'other');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Active pack for source 'other': gbrain-base-v2 ");
    expect(r.stdout).toContain('Source: db-config');
  }, 90_000);

  test('no --source still reports the brain-wide pack', () => {
    const r = runSchema('active');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Active pack: gbrain-base-v2 ');
    expect(r.stdout).not.toContain('Note: database unreadable');
  }, 90_000);

  test('an unreadable DB is surfaced instead of silently reporting file-plane', () => {
    const deadHome = mkdtempSync(join(tmpdir(), 'gbrain-schema-active-dead-db-'));
    try {
      mkdirSync(join(deadHome, '.gbrain'), { recursive: true });
      writeFileSync(
        join(deadHome, '.gbrain', 'config.json'),
        JSON.stringify({
          engine: 'postgres',
          database_url: 'postgres://127.0.0.1:1/gbrain-unreachable',
          schema_pack: 'gbrain-base',
        }),
        'utf-8',
      );
      const r = spawnSync('bun', ['run', 'src/cli.ts', 'schema', 'active'], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GBRAIN_DATABASE_URL: '',
          DATABASE_URL: '',
          GBRAIN_SCHEMA_PACK: '',
          GBRAIN_HOME: deadHome,
        },
        timeout: 60_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Active pack: gbrain-base ');
      expect(r.stdout).toContain('Source: home-config');
      expect(r.stdout).toContain('Note: database unreadable');
    } finally {
      rmSync(deadHome, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('#4653 schema inspection verbs honor DB-config schema_pack (tier 4)', () => {
  test('schema show prints the DB-configured pack header', () => {
    const r = runSchema('show');
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').split('\n')[0]).toBe('# gbrain-base-v2 v1.3.0');
  }, 90_000);

  test('schema explain <v2-only type> exits 0', () => {
    // `tweet` exists only in gbrain-base-v2 — pre-fix: exit 1, "not in active pack `gbrain-base`".
    const r = runSchema('explain', 'tweet', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout ?? '').pack).toBe('gbrain-base-v2');
  }, 90_000);

  test('schema graph --json and schema lint --json report the DB-configured pack', () => {
    const graph = runSchema('graph', '--json');
    expect(graph.status).toBe(0);
    expect(JSON.parse(graph.stdout ?? '').pack).toBe('gbrain-base-v2');
    const lint = runSchema('lint', '--json');
    expect(JSON.parse(lint.stdout ?? '').pack).toBe('gbrain-base-v2');
  }, 120_000);
});
