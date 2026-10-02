// issue #5832 — runPhaseExtractAtoms' item loop must honor `opts.signal`.
// The drain threads the combined lock-loss + caller signal into the phase so
// a lost `gbrain-cycle:<source>` lease stops the batch at the next item
// boundary instead of writing atoms for the rest of a possibly hours-long
// loop while another holder runs the same source's cycle. The check is
// cooperative: an in-flight `chat()` may finish, but no NEW item starts.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from '../helpers/extract-atoms-page-fixtures.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function okChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  };
}

function pages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    slug: `note/sig-${i}`,
    content: `page ${i}`,
    contentHash: String(i + 1).repeat(16),
  }));
}

describe('extract_atoms honors the abort signal (#5832)', () => {
  test('a pre-aborted signal processes zero items — no chat call, no writes', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('lock lost before batch'));
    let chatCalls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: pages(3),
      _chat: async (_o: ChatOpts) => { chatCalls++; return okChatResult('[]'); },
      signal: ctl.signal,
    });
    expect(chatCalls).toBe(0);
    expect(result.details.pages_processed).toBe(0);
    expect(result.details.transcripts_processed).toBe(0);
  });

  test('an abort mid-loop stops scheduling new items at the next boundary', async () => {
    const ctl = new AbortController();
    let chatCalls = 0;
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [],
      _pages: pages(4),
      _chat: async (_o: ChatOpts) => {
        chatCalls++;
        if (chatCalls === 1) ctl.abort(new Error('lock stolen mid-batch'));
        return okChatResult('[]');
      },
      signal: ctl.signal,
    });
    // The in-flight item completes cooperatively; every later item is skipped.
    expect(chatCalls).toBe(1);
    expect(result.details.pages_processed).toBe(1);
  });
});
