/**
 * #6192 — retrieval_feedback_health must warn when many answers are recorded
 * but no rating has ever landed: an answer_id that cannot reach the model is
 * indistinguishable from a healthy brain on the old check, so `ok` hid the
 * exact MCP visibility gap it was meant to surface.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { retrievalFeedbackEntry } from '../src/commands/doctor/checks/retrieval-feedback.ts';
import { applyRatings, insertRetrievalEvents } from '../src/core/feedback/store.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', { type: 'person', title: 'people/alice-example', compiled_truth: 'about alice' });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('feedback.enabled', 'true');
  _resetFeedbackSettingsCacheForTests();
});

async function run(): Promise<Check> {
  const ctx = { engine, progress: { heartbeat() {}, finish() {} } } as unknown as DoctorContext;
  const checks = (await retrievalFeedbackEntry.run(ctx)) as Check[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

async function seedAnswers(n: number) {
  const events = Array.from({ length: n }, (_, i) => ({
    id: `ans_test_${i}`,
    client_id: 'local',
    op: 'query' as const,
    pages: [{ source_id: 'default', slug: 'people/alice-example', content_hash: null, rank: 0, cited: false }],
    links: [],
  }));
  await insertRetrievalEvents(engine, events);
}

describe('retrieval_feedback_health zero-ratings warn (#6192)', () => {
  test('enabled, many answers, zero ratings → warn', async () => {
    await seedAnswers(20);
    const c = await run();
    expect(c.status).toBe('warn');
    expect(c.message).toContain('20 answers recorded');
    expect(c.details?.ratings_explicit).toBe(0);
  });

  test('enabled, few answers, zero ratings → ok (below the threshold)', async () => {
    await seedAnswers(19);
    const c = await run();
    expect(c.status).toBe('ok');
  });

  test('enabled, answers with a landed rating → ok', async () => {
    await seedAnswers(20);
    await applyRatings(engine, {
      eventId: 'ans_test_0', clientId: 'local', signal: 'explicit', alpha: 0.25,
      targets: [{ kind: 'page', source_id: 'default', key: 'people/alice-example', rating: 5, content_hash: null }],
    });
    const c = await run();
    expect(c.status).toBe('ok');
  });
});
