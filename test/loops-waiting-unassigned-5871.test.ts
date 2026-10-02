/**
 * #5871 — `gbrain waiting` grouped view: a counterparty-less bucket ('unknown'
 * — mostly decision_pending loops) outranked every real person on raw loop
 * count, and renderText printed every loop of every group (a 327 KB default
 * envelope).
 *
 * Now: counterparty-less loops report separately as `unassigned` (never a
 * person group), the text digest caps at 10 loops per group with a
 * "… and N more" tail, and the internal fetch cap is 5,000 (was 500 — the
 * reporter's brain silently dropped 37 loops from ranking).
 * PGLite in-memory.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at)
     VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
  );
});

const openLoopsOp = loopsOperations.find((o) => o.name === 'open_loops')!;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'g1',
    ...over,
  } as OperationContext;
}

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'g1',
    dedupKey: `thread:${over.threadId ?? '18c2f4a9b3d21e07'}:${over.loopType ?? 'unanswered_inbound'}`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'bob@example.com',
    summary: 'Reply owed to bob@example.com: "Quarterly plan" (2d)',
    evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review the plan?' }],
    threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread',
    ...over,
  };
}

interface GroupsResult {
  groups: Array<{ counterparty: string; loop_count: number }>;
  unassigned?: { counterparty: string; loop_count: number; loops: Array<Record<string, unknown>> } | null;
  count: number;
  truncated: boolean;
  text?: string;
}

const pending = (i: number): OpenLoopUpsert =>
  loop({
    dedupKey: `decision:${i}`,
    loopType: 'decision_pending',
    counterpartyEmail: null,
    counterpartySlug: null,
    summary: `Decision pending ${i}: approve the migration window?`,
    evidence: [{ message_id: `m${i}`, quote: 'thoughts?' }],
    threadId: `t${i}`,
    detector: 'llm_extract',
  });

describe('open_loops unassigned bucket (#5871)', () => {
  test('counterparty-less loops leave the people ranking and report as unassigned', async () => {
    for (let i = 0; i < 5; i++) await upsertOpenLoop(engine, pending(i));
    await upsertOpenLoop(engine, loop({ threadId: 'ta', counterpartyEmail: 'alice@example.com' }));
    const res = (await openLoopsOp.handler(ctx({ remote: true }), {})) as GroupsResult;
    expect(res.groups.map((g) => g.counterparty)).toEqual(['alice@example.com']);
    expect(res.unassigned?.loop_count).toBe(5);
    expect(res.unassigned?.counterparty).toBe('unassigned');
    expect(res.count).toBe(6);
  });

  test('a brain with ONLY counterparty-less loops reports no person group, not a fake "unknown" person', async () => {
    for (let i = 0; i < 3; i++) await upsertOpenLoop(engine, pending(i));
    const res = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    expect(res.groups).toHaveLength(0);
    expect(res.unassigned?.loop_count).toBe(3);
    expect(res.text!).not.toContain('## unknown');
    expect(res.text!).toContain('## Unassigned — no counterparty (3 open)');
    expect(res.text!).not.toContain('You are clean');
  });

  test('the text digest caps loops per group with a remainder count (JSON stays complete)', async () => {
    for (let i = 0; i < 14; i++) await upsertOpenLoop(engine, pending(i));
    const res = (await openLoopsOp.handler(ctx({ remote: false }), {})) as GroupsResult;
    expect(res.unassigned?.loops).toHaveLength(14); // JSON complete
    expect(res.text!).toContain('## Unassigned — no counterparty (14 open)');
    expect(res.text!).toContain('… and 4 more');
    // only 10 loop lines rendered
    expect(res.text!.split('\n').filter((l) => l.startsWith('- [decision_pending]'))).toHaveLength(10);
  });
});
