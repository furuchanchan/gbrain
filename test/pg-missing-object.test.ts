/**
 * #6599: old-schema compatibility predicates accept only the exact missing
 * object, not a broad message match.
 *
 * Protects: `readRecordedHaltReasons7d` and `computeExtractHealthCheck`
 * treat 42703/`halt_reasons` and 42P01/`extract_rollup_7d` as "schema
 * behind" and propagate every other driver error — including ones whose
 * text mentions the object (a 42501 permission error naming the column, a
 * 22P02 whose literal happens to contain "no such table"). Driver metadata
 * (`table_name`/`column_name` on native Postgres, `table`/`column` PGLite
 * variants) decides the object when present; a numeric Bun `Error.column`
 * is a source position, never an identifier; contradictory metadata is not
 * overridden by incidental text. `upsertExtractRollup`'s schema-behind hint
 * fires only for the real missing column.
 * Fails when: a non-missing-object error is swallowed into a compat branch
 * (false OK/empty read), or a true missing-object error stops degrading.
 * Offline: stub engines throw driver-shaped errors; no database needed.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { isMissingPgColumn, isMissingPgRelation, pgMissingObject } from '../src/core/pg-missing-object.ts';
import { readRecordedHaltReasons7d, upsertExtractRollup, classifyRunStop } from '../src/core/extract/rollup-writer.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';

const throwing = (err: unknown) => ({ executeRaw: async () => { throw err; } }) as unknown as Pick<BrainEngine, 'executeRaw'>;

const driverErr = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });

describe('pgMissingObject names only the object a 42P01/42703 error is about', () => {
  test('metadata decides when present, including PGLite `table`/`column` variants', () => {
    expect(pgMissingObject(driverErr('42P01', 'boom', { table_name: 'extract_rollup_7d' })))
      .toEqual({ kind: 'relation', name: 'extract_rollup_7d' });
    expect(pgMissingObject(driverErr('42703', 'boom', { column_name: 'halt_reasons' })))
      .toEqual({ kind: 'column', name: 'halt_reasons' });
    expect(pgMissingObject(driverErr('42P01', 'boom', { table: 'extract_rollup_7d' })))
      .toEqual({ kind: 'relation', name: 'extract_rollup_7d' });
    expect(pgMissingObject(driverErr('42703', 'boom', { column: 'halt_reasons' })))
      .toEqual({ kind: 'column', name: 'halt_reasons' });
  });
  test('exact-identifier message fallback when the driver omits metadata', () => {
    expect(pgMissingObject(driverErr('42P01', 'relation "extract_rollup_7d" does not exist')))
      .toEqual({ kind: 'relation', name: 'extract_rollup_7d' });
    expect(pgMissingObject(driverErr('42703', 'column r.halt_reasons does not exist')))
      .toEqual({ kind: 'column', name: 'halt_reasons' });
    expect(pgMissingObject(driverErr('42P01', 'no such table: extract_rollup_7d')))
      .toEqual({ kind: 'relation', name: 'extract_rollup_7d' });
  });
  test('a numeric Bun Error.column is a source position, not an identifier', () => {
    expect(pgMissingObject(driverErr('42703', 'column r.halt_reasons does not exist', { column: 47 })))
      .toEqual({ kind: 'column', name: 'halt_reasons' });
    expect(pgMissingObject(driverErr('42703', 'unrelated text', { column: 47 }))).toBeNull();
  });
  test('contradictory metadata is not overridden by incidental text', () => {
    expect(pgMissingObject(driverErr('42P01', 'relation "extract_rollup_7d" does not exist', { table_name: 'pages' })))
      .toEqual({ kind: 'relation', name: 'pages' });
    expect(isMissingPgRelation(driverErr('42P01', 'relation "extract_rollup_7d" does not exist', { table_name: 'pages' }), 'extract_rollup_7d')).toBe(false);
  });
  test('any other SQLSTATE or message-only match is not a missing object', () => {
    expect(pgMissingObject(driverErr('42501', 'permission denied for halt_reasons diagnostic'))).toBeNull();
    expect(pgMissingObject(driverErr('22P02', 'invalid input syntax for integer: "no such table"'))).toBeNull();
    expect(pgMissingObject(driverErr('42P01', 'relation "pages" does not exist'))).toEqual({ kind: 'relation', name: 'pages' });
    expect(isMissingPgColumn(driverErr('42703', 'column r.other does not exist'), 'halt_reasons')).toBe(false);
    expect(pgMissingObject(new Error('relation "extract_rollup_7d" does not exist'))).toBeNull();
  });
});

describe('readRecordedHaltReasons7d propagates real driver errors (#6599)', () => {
  test('a 42501 error mentioning halt_reasons throws instead of reading as empty', async () => {
    await expect(readRecordedHaltReasons7d(throwing(driverErr('42501', 'permission denied for halt_reasons diagnostic'))))
      .rejects.toThrow('permission denied');
  });
  test('true pre-v239 column absence still reads as no recorded reasons', async () => {
    await expect(readRecordedHaltReasons7d(throwing(driverErr('42703', 'column r.halt_reasons does not exist'))))
      .resolves.toEqual(new Map());
    await expect(readRecordedHaltReasons7d(throwing(driverErr('42703', 'boom', { column_name: 'halt_reasons' }))))
      .resolves.toEqual(new Map());
  });
  test('true pre-v106 relation absence also reads as no recorded reasons', async () => {
    await expect(readRecordedHaltReasons7d(throwing(driverErr('42P01', 'relation "extract_rollup_7d" does not exist'))))
      .resolves.toEqual(new Map());
  });
  test('a missing column that is not halt_reasons throws', async () => {
    await expect(readRecordedHaltReasons7d(throwing(driverErr('42703', 'column r.cost_usd does not exist'))))
      .rejects.toThrow();
  });
});

describe('computeExtractHealthCheck reports WARN for real errors, OK only for the absent table (#6599)', () => {
  test('a 22P02 whose text says "no such table" warns instead of claiming the rollup is absent', async () => {
    const check = await computeExtractHealthCheck(throwing(driverErr('22P02', 'invalid input syntax for integer: "no such table"')) as BrainEngine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('rollup query failed');
  });
  test('a 42501 error mentioning extract_rollup_7d warns', async () => {
    const check = await computeExtractHealthCheck(throwing(driverErr('42501', 'permission denied for table extract_rollup_7d')) as BrainEngine);
    expect(check.status).toBe('warn');
  });
  test('true pre-v106 absence still reports OK', async () => {
    const check = await computeExtractHealthCheck(throwing(driverErr('42P01', 'relation "extract_rollup_7d" does not exist')) as BrainEngine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('not yet present');
    const meta = await computeExtractHealthCheck(throwing(driverErr('42P01', 'boom', { table_name: 'extract_rollup_7d' })) as BrainEngine);
    expect(meta.status).toBe('ok');
  });
});

describe('upsertExtractRollup names the missing column, not incidental text (#6599)', () => {
  test('a 42501 error mentioning halt_reasons gets the generic failure, not the schema-behind hint', async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const res = await upsertExtractRollup(
        throwing(driverErr('42501', 'permission denied for column halt_reasons')) as BrainEngine,
        { kind: 'probe.kind', source_id: 'default', ...classifyRunStop({ error: 'item_error' }) },
      );
      expect(res.ok).toBe(false);
    } finally { console.error = orig; }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('permission denied');
    expect(lines[0]).not.toContain('schema is behind');
  });
  test('a real missing expected_limit_count still retries the pre-v141 statement', async () => {
    let calls = 0;
    const engine = {
      executeRaw: async () => {
        calls++;
        if (calls === 1) throw driverErr('42703', 'column extract_rollup_7d.expected_limit_count does not exist');
        return [];
      },
    } as unknown as BrainEngine;
    const res = await upsertExtractRollup(engine, { kind: 'probe.kind', source_id: 'default', expected_limit_delta: 1 });
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
