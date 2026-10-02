/**
 * Migration v190 — facts-withdrawal search_path hardening (#5190).
 *
 * Validates the search_path pin lands on the four withdrawal functions the
 * Supabase linter flags as function_search_path_mutable (and their two
 * same-file siblings), plus migration idempotency. Mirrors the
 * test/migration-v120.test.ts pattern: initSchema applies the full chain on a
 * fresh PGLite, so the proconfig rows prove the pin end-to-end.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

describe('migration v190 — facts-withdrawal search_path', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('withdrawal functions carry SET search_path after migrations', async () => {
    const rows = await engine.executeRaw<{ proname: string; proconfig: unknown }>(
      `SELECT p.proname, p.proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('gbrain_fact_fingerprint_v1','gbrain_fact_normalize',
                            'gbrain_fact_fingerprint','gbrain_preserve_fact_withdrawal')`,
    );
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(JSON.stringify(r.proconfig ?? [])).toContain('search_path=');
    }
  }, 30000);

  test('gbrain_fact_fingerprint still folds whitespace/case after the pin', async () => {
    const rows = await engine.executeRaw<{ a: string; b: string }>(
      `SELECT gbrain_fact_fingerprint('Moved to SF.') AS a, gbrain_fact_fingerprint('moved   to sf') AS b`,
    );
    expect(rows[0].a).toBe(rows[0].b);
    expect(rows[0].a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('re-running migrations after initSchema is idempotent (0 applied, no error)', async () => {
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
  });
});
