import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor.ts';
import {
  isConversationFactsEligiblePage,
  REQUIRE_PARSEABLE_FLAG_CONFIG_KEY,
} from '../src/commands/extract-conversation-facts.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
});

async function seedPage(slug: string, type: string, frontmatter: Record<string, unknown> = {}): Promise<void> {
  await engine.putPage(slug, {
    type,
    title: slug,
    compiled_truth: 'A page body long enough for the doctor backlog fixture.',
    timeline: '',
    frontmatter,
  });
}

describe('conversation_facts_backlog eligibility', () => {
  test('default preserves 2 eligible', async () => {
    await seedPage('slack/support-alex', 'slack');
    await seedPage('email/source-evidence', 'email');
    const check = await computeConversationFactsBacklogCheck(engine);
    expect(check.message).toContain('2 eligible');
    expect(check.details?.backlog).toBe(2);
  });

  test('require_parseable_flag excludes source-evidence → 1 eligible', async () => {
    await engine.setConfig(REQUIRE_PARSEABLE_FLAG_CONFIG_KEY, 'true');
    // Strict mode admits 'conversation' or an explicit parseable marker only;
    // the unmarked slack page and unmarked email are both source evidence.
    await seedPage('slack/support-alex', 'slack');
    await seedPage('email/source-evidence', 'email');
    await seedPage('email/threads/parseable', 'email', { conversation_parseable: true });
    const check = await computeConversationFactsBacklogCheck(engine);
    expect(check.message).toContain('1 eligible');
    expect(check.details?.backlog).toBe(1);
    expect(check.details?.require_parseable_flag).toBe(true);
  });

  test('conversation_parseable: false is excluded even without the flag', async () => {
    await seedPage('slack/support-alex', 'slack');
    await seedPage('slack/off-limits', 'slack', { conversation_parseable: false });
    const check = await computeConversationFactsBacklogCheck(engine);
    expect(check.details?.backlog).toBe(1);
  });

  test('explicit opt-in keeps email eligible under the flag', async () => {
    await engine.setConfig(REQUIRE_PARSEABLE_FLAG_CONFIG_KEY, 'true');
    await seedPage('email/opted-in', 'email', { conversation_parseable: true });
    const check = await computeConversationFactsBacklogCheck(engine);
    expect(check.details?.backlog).toBe(1);
  });
});

describe('isConversationFactsEligiblePage', () => {
  const types = ['conversation', 'meeting', 'slack', 'email'];

  test('type mismatch is never eligible', () => {
    expect(isConversationFactsEligiblePage({ type: 'note', frontmatter: {} }, types)).toBe(false);
  });

  test('default mode: unknown marker stays eligible', () => {
    expect(isConversationFactsEligiblePage({ type: 'email', frontmatter: {} }, types)).toBe(true);
    expect(isConversationFactsEligiblePage({ type: 'slack', frontmatter: {} }, types)).toBe(true);
  });

  test('falsey marker always excludes', () => {
    expect(isConversationFactsEligiblePage({ type: 'conversation', frontmatter: { conversation_parseable: false } }, types)).toBe(false);
    expect(isConversationFactsEligiblePage({ type: 'slack', frontmatter: { conversation_parseable: 'no' } }, types)).toBe(false);
    expect(isConversationFactsEligiblePage({ type: 'meeting', frontmatter: { conversation_parseable: 'OFF' } }, types)).toBe(false);
  });

  test('strict mode: conversation type passes, others need truthy marker', () => {
    expect(isConversationFactsEligiblePage({ type: 'conversation', frontmatter: {} }, types, true)).toBe(true);
    expect(isConversationFactsEligiblePage({ type: 'email', frontmatter: {} }, types, true)).toBe(false);
    expect(isConversationFactsEligiblePage({ type: 'email', frontmatter: { conversation_parseable: 'yes' } }, types, true)).toBe(true);
  });
});
