/**
 * #5820 — Stop-hook ambient write-back must skip gbrain's own claude-cli
 * subprocess sessions the same way the SessionEnd lane does (#5413). Two
 * guards, one session class:
 *
 *   1. hook lane — `hookStop`'s write-back step skips banking when the
 *      transcript path OR the payload cwd carries the claude-cli scratch-cwd
 *      fingerprint (typed `self_transcript` reason, classified by-design ok).
 *   2. harvest lane — `runWritebackTurn` terminal-sidecars a banked turn
 *      whose session id is a claude-cli self session (the sweep's
 *      `self_capture` classification), instead of extracting it — each
 *      extraction call is a NEW claude-cli session, so WRITEBACK_SESSION_CAP
 *      cannot bound the loop.
 *
 * Serial: real PGLite engine + env mutation (GBRAIN_HOME, CLAUDE_CONFIG_DIR).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runHook } from '../src/commands/hook.ts';
import { readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';
import {
  __drainCheckpointHarvestForTests,
  __resetCheckpointHarvestForTests,
  scheduleCheckpointHarvest,
  shutdownCheckpointHarvest,
} from '../src/core/context/checkpoint-harvest.ts';
import { bankWritebackTurn } from '../src/core/context/corpus-segments.ts';
import { gateWritebackTurn } from '../src/core/facts/writeback-gate.ts';
import { CORPUS_INGESTED_SUFFIX } from '../src/core/sweep.ts';
import { CLAUDE_CLI_CWD_PREFIX } from '../src/core/ai/providers/claude-cli-scratch.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import type { CapabilityReport } from '../src/core/capability.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_STOP_PUSH', 'CLAUDE_CONFIG_DIR', 'DATABASE_URL', 'GBRAIN_DATABASE_URL'] as const;

let engine: PGLiteEngine;
let tmp: string;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await shutdownCheckpointHarvest();
  await engine.disconnect();
});

beforeEach(() => {
  __resetCheckpointHarvestForTests();
  tmp = mkdtempSync(join(tmpdir(), 'gb-wbself-'));
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = tmp;
});

afterEach(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await engine.unsetConfig('memory.auto_writeback').catch(() => {});
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');
const corpus = () => join(home(), 'transcripts', 'corpus');

function writeConfig(opts: { writeback?: string } = {}): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(tmp, 'pglite-data'),
    ...(opts.writeback ? { memory: { auto_writeback: opts.writeback } } : {}),
  }));
}

/** Claude-code JSONL transcript with one substantive user turn + reply. */
function writeTranscript(dir: string, name = 'session.jsonl'): { path: string; root: string } {
  const root = join(tmp, dir);
  mkdirSync(root, { recursive: true });
  const p = join(root, name);
  writeFileSync(p, [
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: 'I prefer dark mode in every editor, please set it up.' },
      uuid: 'u-1', sessionId: 's-x', timestamp: '2026-09-01T10:00:00.000Z',
    }),
    JSON.stringify({
      parentUuid: 'u-1', isSidechain: false, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done — noted.' }] },
      uuid: 'a-1', sessionId: 's-x', timestamp: '2026-09-01T10:00:05.000Z',
    }),
  ].join('\n') + '\n');
  return { path: p, root };
}

const io = { write: () => {} };

async function wbHeartbeats() {
  return (await readHeartbeatTail(20)).filter((e) => e.event === 'writeback-bank');
}

function wbFiles(): string[] {
  if (!existsSync(corpus())) return [];
  return readdirSync(corpus()).filter((n) => n.includes('.wb-'));
}

/** Seed a claude-cli scratch project holding `sessionId`.jsonl under a
 *  sandboxed CLAUDE_CONFIG_DIR. */
function seedSelfSession(sessionId: string): string {
  const claudeDir = join(tmp, 'claude');
  const project = join(claudeDir, 'projects', `-tmp-${CLAUDE_CLI_CWD_PREFIX.replace(/[^a-z0-9]/gi, '-')}9999`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), '{}\n');
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  return claudeDir;
}

describe('hook lane — hookStop write-back self-transcript skip', () => {
  test('transcript path inside a claude-cli scratch project: skipped before banking', async () => {
    writeConfig({ writeback: 'salient' });
    // Transcript lives under a *-gbrain-claude-cli-cwd-* project dir — the
    // session is gbrain's OWN extraction subprocess, not the operator's.
    const t = writeTranscript(`projects/-tmp-${CLAUDE_CLI_CWD_PREFIX.replace(/[^a-z0-9]/gi, '-')}4242`);
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 'self-1', transcript_path: t.path }),
    });
    expect(code).toBe(0);
    expect(wbFiles()).toEqual([]);
    const hb = (await wbHeartbeats()).at(-1);
    expect(hb?.reason).toBe('self_transcript');
    expect(hb?.outcome).toBe('ok');
  });

  test('normal transcript but payload cwd is the scratch dir: skipped on cwd fingerprint', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTranscript('projects/-home-user-work');
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({
        session_id: 'self-2', transcript_path: t.path,
        cwd: join(tmpdir(), `${CLAUDE_CLI_CWD_PREFIX}7777`),
      }),
    });
    expect(code).toBe(0);
    expect(wbFiles()).toEqual([]);
    const hb = (await wbHeartbeats()).at(-1);
    expect(hb?.reason).toBe('self_transcript');
  });

  test('control: an ordinary session still banks its gated turn', async () => {
    writeConfig({ writeback: 'salient' });
    const t = writeTranscript('projects/-home-user-work');
    const code = await runHook(['stop'], {
      ...io, transcriptRoot: t.root,
      stdin: JSON.stringify({ session_id: 'real-1', transcript_path: t.path }),
    });
    expect(code).toBe(0);
    expect(wbFiles().length).toBe(1);
  });
});

describe('harvest lane — runWritebackTurn self-capture skip', () => {
  async function bankWb(sessionId: string, turn: string): Promise<string> {
    const gated = gateWritebackTurn(turn);
    if (!gated.ok) throw new Error(`fixture turn gated: ${gated.reason}`);
    const banked = await bankWritebackTurn(corpus(), sessionId, gated.normalized, gated.hash24);
    if (!banked.flushCorpusFile) throw new Error(`bank failed: ${banked.status}`);
    return banked.flushCorpusFile;
  }

  test('banked turn from a claude-cli self session: terminal self_capture sidecar, zero facts', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    mkdirSync(corpus(), { recursive: true });
    seedSelfSession('self-sess-1');
    const file = await bankWb('self-sess-1', 'I prefer dark mode in every editor, set it everywhere.');
    scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'self-sess-1', corpusDir: corpus(), file,
      capabilities: KEYED, lane: 'writeback',
    });
    await __drainCheckpointHarvestForTests();
    const sidecarPath = join(corpus(), file + CORPUS_INGESTED_SUFFIX);
    expect(existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(readFileSync(sidecarPath, 'utf8'))).toMatchObject({ skipped: 'self_capture' });
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM facts WHERE source = 'hook:writeback'`,
    );
    expect(rows).toEqual([]);
  });

  test('control: a banked turn from a real session still extracts', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    mkdirSync(corpus(), { recursive: true });
    seedSelfSession('self-sess-1');
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({ facts: [{ fact: 'prefers dark mode', kind: 'decision', entity: null, confidence: 1.0, notability: 'high' }] }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));
    const file = await bankWb('sess-real-1', 'I prefer dark mode in every editor, set it everywhere.');
    scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-real-1', corpusDir: corpus(), file,
      capabilities: KEYED, lane: 'writeback',
    });
    await __drainCheckpointHarvestForTests();
    const rows = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source = 'hook:writeback'`,
    );
    expect(rows.length).toBe(1);
  });
});
