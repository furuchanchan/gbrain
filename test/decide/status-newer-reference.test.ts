/**
 * #6497 `gbrain decide status`: the "newer reference available" hint is
 * scoped to the calibration's call site. For `conflict` the sweep and
 * review_withdraw reference rows are different calibrations — the
 * review_withdraw row is never "newer" for the sweep line status reports.
 * And the hint's `adopt ref:<id>` form must run: it stores the ref verbatim
 * in `decide.slots.<slot>.calibration`, which `selectCalibration` reads.
 * Serial: captures console.log/console.error and sets TYPESAFE_API_KEY.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runDecideCommand } from '../../src/commands/decide.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test' } });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function decide(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  try {
    return { code: await runDecideCommand(engine, args), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('decide status: newer reference hint is call-site scoped (#6497)', () => {
  test('the conflict line names no newer reference — the newest sweep ref is already in use', async () => {
    const r = await decide(['status', '--json']);
    expect(r.code).toBe(0);
    const conflict = JSON.parse(r.out).slots.find((s: { slot: string }) => s.slot === 'conflict');
    expect(conflict.calibration).toBe('ref:conflict-jev-1.13.0-2026-09-30');
    // master prints ref:conflict-review-withdraw-jev-1.13.0-2026-10-05 here —
    // a different call site, never "newer" for this line.
    expect(conflict.newer_reference).toBeNull();
  });

  test('calibrations adopt accepts ref:<id> and stores it verbatim', async () => {
    const r = await decide(['calibrations', 'adopt', 'ref:conflict-review-withdraw-jev-1.13.0-2026-10-05']);
    // master exits 1 with the usage line: Number('ref:…') is NaN.
    expect(r.code).toBe(0);
    expect(await engine.getConfig('decide.slots.conflict.calibration'))
      .toBe('ref:conflict-review-withdraw-jev-1.13.0-2026-10-05');
  });

  test('calibrations retire/restore still refuse ref:<id>', async () => {
    for (const action of ['retire', 'restore']) {
      const r = await decide(['calibrations', action, 'ref:conflict-jev-1.13.0-2026-09-30']);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`Usage: gbrain decide calibrations ${action} <id>`);
    }
  });
});
