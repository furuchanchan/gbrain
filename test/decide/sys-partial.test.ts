/**
 * UDKB-251 v2 F1 (V-a, paid #12405/#12408): audit-only partial answers when a
 * sys-lane batch group fails partway.
 *
 * Arms (regression boundary per paid #12401/#12408):
 *  1. mixed-outcome sys group (batch 0 ok, batch 1 past deadline): runDecide
 *     still THROWS (group failure — throw/fail-fast semantics unchanged) and
 *     the DecideError carries `partial` with the settled batch's answers,
 *     model_resolved and input tokens.
 *  2. all-ok group: returns normally, no partial anywhere.
 *  3. all-failing group: throws with partial undefined (nothing settled).
 *
 * Synthetic endpoints only (local mock /v1/systemone); no real credentials,
 * no provider deployment, no UDKB-private content.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DecideError } from '../../src/core/ai/decide/types.ts';
import { runDecide } from '../../src/core/ai/decide/index.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { readDecideConfig } from '../../src/core/ai/decide/config.ts';

const PROBE = 'synthetic non-sensitive connectivity probe';

async function withMock(handler: (n: number, body: string, res: any) => void, fn: (base: string) => Promise<void>) {
  let reqn = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => handler(reqn++, body, res));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

function answerBody(body: string, model: string) {
  let questions: string[] = [];
  try { questions = Object.keys(JSON.parse(body).questions ?? {}); } catch {}
  const answers: Record<string, unknown> = {};
  for (const id of questions) answers[id] = { type: 'noul', noul: 0.42 };
  return JSON.stringify({ model, answers, usage: { input_tokens: 100, output_tokens: 0 } });
}

// ~24k conservative tokens each: under the 32k state+longest budget solo, but
// any two pair up under 64k while three overflow it — planner emits [q0,q1],[q2].
const bigQ = (i: number) => `Candidate ${i} synthetic body: ` + 'padding '.repeat(12500) + ' Is this ordinary content?';
const groupQuestions = [
  { id: 'evidence:0', kind: 'noul' as const, instructions: bigQ(0) },
  { id: 'evidence:1', kind: 'noul' as const, instructions: bigQ(1) },
  { id: 'evidence:2', kind: 'noul' as const, instructions: bigQ(2) },
];

const realFetch = globalThis.fetch;
// The mock model id has no shipped tariff; an operator override prices it so
// runTypesafe's unpriced_model pre-flight does not fire before transport.
const PRICED_CFG = readDecideConfig({ 'pricing.overrides': '{"typesafe:mock-model": {"input": 1, "output": 0}}', 'decide.egress.private': 'allow', 'decide.egress.typesafe.query': 'allow', 'decide.egress.typesafe.candidates': 'allow', 'decide.egress.typesafe.facts': 'allow', 'decide.egress.typesafe.conversation': 'allow' }, { typesafeKey: true });
// Same isolation convention as the existing suites (consolidate-divergence,
// v0_37_gap_fill): reset the process-global gateway after each arm so a local
// mock base URL never leaks into sibling tests in the same run.
afterEach(() => {
  globalThis.fetch = realFetch;
  resetGateway();
});

describe('sys-lane partial answers (audit-only, group still fails)', () => {
  test('mixed-outcome group throws and carries settled-batch answers on DecideError.partial', async () => {
    await withMock((n, body, res) => {
      // batch 0 (small questions) settles fast; batch 1 exceeds the deadline
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(answerBody(body, 'mock-model'));
      }, n === 0 ? 20 : 9000);
    }, async (base) => {
      configureGateway({ env: { TYPESAFE_API_KEY: 'mock-key' }, base_urls: { typesafe: base } } as never);
      let caught: unknown;
      try {
        await runDecide(
          { slot: 'evidence', callSite: 'search', state: { query: { text: PROBE, class: 'query' as const } },
            questions: groupQuestions, provider: 'typesafe:mock-model', deadlineMs: 500 },
          { engine: null, config: PRICED_CFG },
        );
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(DecideError);
      const de = caught as DecideError;
      expect(de.reason).toBe('timeout');            // group failure is unchanged
      expect(de.partial).toBeDefined();             // audit-only carrier
      // Which batch settles depends on request arrival order (16-way concurrency);
      // the contract is that the settled batch's answers ride the error for audit.
      expect(Object.keys(de.partial!.answers).length).toBeGreaterThanOrEqual(1);
      expect(Object.values(de.partial!.answers)[0]).toMatchObject({ kind: 'noul' });
      expect(de.partial!.model_resolved).toBe('mock-model');
      expect(typeof de.partial!.input_tokens).toBe('number');
    });
  });

  test('all-ok group returns normally with no partial', async () => {
    await withMock((_n, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(answerBody(body, 'mock-model'));
    }, async (base) => {
      configureGateway({ env: { TYPESAFE_API_KEY: 'mock-key' }, base_urls: { typesafe: base } } as never);
      const r = await runDecide(
        { slot: 'evidence', callSite: 'search', state: { query: { text: PROBE, class: 'query' as const } },
          questions: groupQuestions, provider: 'typesafe:mock-model', deadlineMs: 8000 },
        { engine: null, config: PRICED_CFG },
      );
      expect(r.model_resolved).toBe('mock-model');
      expect(Object.keys(r.answers).length).toBe(3);
    });
  });

  test('mixed settled models leave partial.model_resolved null (no single identity asserted)', async () => {
    await withMock((n, body, res) => {
      setTimeout(() => {
        // the two settled batches disagree on the resolved model
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(answerBody(body, n === 0 ? 'mock-model-a' : 'mock-model-b'));
      }, n === 0 ? 20 : (n === 1 ? 40 : 9000));
    }, async (base) => {
      configureGateway({ env: { TYPESAFE_API_KEY: 'mock-key' }, base_urls: { typesafe: base } } as never);
      let caught: unknown;
      try {
        await runDecide(
          { slot: 'evidence', callSite: 'search', state: { query: { text: PROBE, class: 'query' as const } },
            questions: groupQuestions, provider: 'typesafe:mock-model', deadlineMs: 500 },
          { engine: null, config: PRICED_CFG },
        );
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(DecideError);
      const de = caught as DecideError;
      expect(de.reason).toBe('mixed_model');                   // the mixed-model throw (outside the batch catch)
      expect(de.partial).toBeDefined();
      expect(de.partial!.answers['evidence:0']).toBeDefined(); // settled batches' answers kept for audit
      expect(de.partial!.model_resolved).toBeNull();           // but NO single model identity asserted
    });
  });

  test('all-failing group throws with partial undefined', async () => {
    await withMock((_n, _body, res) => {
      setTimeout(() => { res.writeHead(500); res.end('internal'); }, 50);
    }, async (base) => {
      configureGateway({ env: { TYPESAFE_API_KEY: 'mock-key' }, base_urls: { typesafe: base } } as never);
      let caught: unknown;
      try {
        await runDecide(
          { slot: 'evidence', callSite: 'search', state: { query: { text: PROBE, class: 'query' as const } },
            questions: groupQuestions, provider: 'typesafe:mock-model', deadlineMs: 2000 },
          { engine: null, config: PRICED_CFG },
        );
      } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(DecideError);
      expect((caught as DecideError).reason).toBe('provider_error');
      expect((caught as DecideError).partial).toBeUndefined(); // nothing settled — no carrier
    });
  });
});
