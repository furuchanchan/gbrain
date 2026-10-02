/**
 * #5448 — `--json` was advertised in cli-flag-registry but the parser refused
 * it with `Unknown flag` (exit 1). The flag now emits ONE machine-readable
 * JSON object carrying the same counters as the human `Done:` summary, with
 * exit-code semantics unchanged. Serial: gateway transport stubs + console spies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runExtractConversationFacts } from '../src/commands/extract-conversation-facts.ts';

let engine: PGLiteEngine;
let calls = 0;
const GATEWAY = { chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' } };
const body = "{'source': 'microphone', 'attribution': 'me'}: hello\n{'name': 'alice-example', 'attribution': 'them', 'source': 'speaker'}: hi";

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway(GATEWAY);
  __setChatTransportForTests(async () => {
    calls++;
    return { text: '{"facts":[]}', blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'stub', providerId: 'stub' };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  calls = 0;
  await engine.executeRaw('TRUNCATE facts, pages, op_checkpoints, extract_rollup_7d CASCADE');
  await engine.setConfig('facts.extraction_enabled', 'true');
  await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', ['speaker-a']);
  for (const [slug, type, truth] of [
    ['conversations/object-1', 'conversation', body],
    ['conversations/object-2', 'conversation', body],
    ['conversations/unparsed', 'conversation', 'Opaque prose without speaker turns.'],
    ['people/profile-example', 'person', 'An ordinary profile.'],
  ] as const) {
    await engine.putPage(slug, { title: slug, type, compiled_truth: truth, timeline: '', frontmatter: { date: '2026-06-02' } }, { sourceId: 'speaker-a' });
  }
});

describe('#5448 --json summary', () => {
  test('--json is accepted and prints one JSON object with the Done: counters', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, ['--dry-run', '--sleep', '0', '--types', 'conversation', '--source-id', 'speaker-a', '--json']);
      const lines = log.mock.calls.map((c) => c.join(' '));
      const jsonLine = lines.find((l) => l.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.outcome).toBe('segmentation_only');
      expect(parsed.sources).toEqual(['speaker-a']);
      expect(parsed.pages_considered).toBe(3);
      expect(parsed.pages_processed).toBe(2);
      expect(parsed.segments_processed).toBeGreaterThan(0);
      expect(parsed.pages_skipped_unparsed).toBe(1);
      expect(parsed.pages_skipped_type_mismatch).toBe(0);
      expect(typeof parsed.spent_usd).toBe('number');
      expect(parsed.budget_exhausted).toBe(false);
      // The prose Done: block is suppressed under --json.
      expect(lines.join('\n')).not.toContain('Done:');
      expect(calls).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  test('without --json the human summary is unchanged', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, ['--dry-run', '--sleep', '0', '--types', 'conversation', '--source-id', 'speaker-a']);
      const out = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(out).toContain('Done:');
      expect(out).toContain('segmentation only; no facts extracted');
      expect(out).not.toContain('"dry_run"');
      expect(calls).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  test('real extraction under --json reports extracted counters and one JSON line', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runExtractConversationFacts(engine, ['--sleep', '0', '--types', 'conversation', '--source-id', 'speaker-a', '--json']);
      const lines = log.mock.calls.map((c) => c.join(' '));
      const jsonLine = lines.find((l) => l.startsWith('{'));
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.outcome).toBe('extracted');
      expect(parsed.pages_processed).toBe(2);
      expect(calls).toBe(2);
      expect(lines.join('\n')).not.toContain('Done:');
    } finally {
      log.mockRestore();
    }
  });
});
