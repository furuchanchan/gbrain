// #6193: Postgres returns int8 columns as JavaScript bigint. `list --json` /
// `show --json` used to feed the raw rows to plain JSON.stringify, which
// throws "Do not know how to serialize a BigInt" and counts an agent_contract
// internal error. The shared bigintToStringReplacer emits decimal strings
// (the postgres.js wire shape), so every --json surface stays valid JSON.
import { describe, expect, test, spyOn, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runEdgeProposals } from '../src/commands/edge-proposals.ts';

function stubEngine(id: bigint): BrainEngine {
  const row = {
    id, status: 'proposed', link_type: 'works_at',
    subject: 'people/alice-example', a_target: 'companies/acme-example', b_target: 'companies/widget-co',
    ending: 'companies/widget-co', close_date: '2026-01-02', born_closed: false,
    model: 'test-model', confidence: 0.9, generated_line: null, created_at: new Date('2026-01-01T00:00:00Z'),
  };
  return { executeRaw: async () => [row] } as unknown as BrainEngine;
}

let logged: string[];
let spy: ReturnType<typeof spyOn>;
afterEach(() => spy?.mockRestore());

function capture() { logged = []; spy = spyOn(console, 'log').mockImplementation((m: string) => logged.push(String(m))); }

describe('edge-proposals --json with bigint ids (#6193)', () => {
  test('list --json emits valid JSON with an unsafe-int id as a decimal string', async () => {
    const id = 9007199254740993n;
    capture();
    await runEdgeProposals(stubEngine(id), ['list', '--json']);
    const parsed = JSON.parse(logged.join('\n'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(id.toString());
  });

  test('show --json emits valid JSON with the id as a decimal string', async () => {
    capture();
    await runEdgeProposals(stubEngine(42n), ['show', '42', '--json']);
    const parsed = JSON.parse(logged.join('\n'));
    expect(parsed.id).toBe('42');
  });

  test('text mode still prints the id', async () => {
    const id = 9007199254740993n;
    capture();
    await runEdgeProposals(stubEngine(id), ['list']);
    expect(logged.join('\n')).toContain(`#${id}`);
  });
});
