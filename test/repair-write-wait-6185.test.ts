// #6185: `repair <kind> --apply` built its OperationContext without
// writeWaitMs, so submitPageMutation waited the 5 s agent default instead of
// the CLI write wait (`--wait` > GBRAIN_WRITE_WAIT_MS > persistence.write_wait_ms
// > 30 s). Any publication slower than 5 s came back write_pending and the
// run stopped after one item — 761 items meant 761 runs on the reporter's
// brain. The runner now passes currentCliWriteWait().waitMs like every other
// CLI write path.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { resolveRepairScope, type RepairHandler, type RepairScope } from '../src/core/repair/core.ts';
import { repairRunner, type RepairKindSpec } from '../src/core/repair/registry.ts';
import { CLI_WRITE_WAIT_MS } from '../src/core/persistence/write-wait.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-wait-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function capturedWriteWaitMs(scope: RepairScope): Promise<number | undefined> {
  let seen: number | undefined;
  const handler: RepairHandler = {
    kind: 'timeline',
    publication: 'projection',
    plan: async () => ({ items: [{ cursor: { phase: 0, id: 1 }, source_id: scope.source_ids[0], slug: 'x', chars: 1, action: 'probe' }], residuals: {} }),
    apply: async (ctx: OperationContext) => { seen = ctx.writeWaitMs; return true; },
  };
  const registry: RepairKindSpec[] = [{ kind: 'timeline', handler, summary: 'probe', embeds: 'none', checks: [] }];
  const runner = await repairRunner(engine, { apply: true, logger: { info() {}, warn() {}, error() {} }, registry });
  await runner.run('timeline', scope, { explicit: true });
  return seen;
}

describe('repair runner carries the CLI write wait (#6185)', () => {
  test('defaults to the 30 s CLI write wait, not the 5 s agent default', async () => {
    const scope = await resolveRepairScope(engine);
    const waitMs = await withEnv({ GBRAIN_HOME: home, GBRAIN_WRITE_WAIT_MS: undefined }, () => capturedWriteWaitMs(scope));
    expect(waitMs).toBe(CLI_WRITE_WAIT_MS);
  });

  test('GBRAIN_WRITE_WAIT_MS reaches the operation context', async () => {
    const scope = await resolveRepairScope(engine);
    const waitMs = await withEnv({ GBRAIN_HOME: home, GBRAIN_WRITE_WAIT_MS: '12345' }, () => capturedWriteWaitMs(scope));
    expect(waitMs).toBe(12345);
  });
});
