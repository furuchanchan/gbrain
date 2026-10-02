/**
 * #5756 — the extract_atoms phase applied one hardcoded virality-shaped
 * system prompt to every extractable page. On pages whose value is their
 * exact wording (statutes, contracts, standards, policies) that objective
 * rewrites qualifiers into defects: the reporter measured 7/44 broken
 * atoms on a legal corpus vs 9/9 correct on analytical prose.
 *
 * The issue's stated minimum: `cycle.extract_atoms.prompt_file` names a
 * UTF-8 file whose contents replace the built-in prompt, plus
 * `gbrain dream --print-extract-prompt` to print the effective prompt so
 * the adaptation can be verified after upgrades.
 *
 * Locked here: the resolver (unset/file/unreadable/empty/~/relative),
 * the phase wiring (`chat({system})` receives the file's text and the
 * result names `prompt_source`), and the print flag (stdout + exit 0).
 * No model calls anywhere — the chat gateway is stubbed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveExtractAtomsPrompt } from '../src/core/cycle/extract-atoms-prompt.ts';
import { runPhaseExtractAtoms, EXTRACT_PROMPT } from '../src/core/cycle/extract-atoms.ts';
import { runDream } from '../src/commands/dream.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { ChatResult, ChatOpts } from '../src/core/ai/gateway.ts';

/** Minimal engine stub for the pure resolver tests. */
function stubEngine(config: Record<string, string>): BrainEngine {
  return {
    getConfig: async (key: string) => config[key] ?? null,
  } as unknown as BrainEngine;
}

const FIDELITY_PROMPT =
  'You extract atomic content nuggets. Fidelity first: preserve every ' +
  'qualifier, exception, and defined term verbatim — never strengthen or ' +
  'generalize the wording.';

describe('resolveExtractAtomsPrompt', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'atoms-prompt-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('unset key → null prompt (built-in default)', async () => {
    const r = await resolveExtractAtomsPrompt(stubEngine({}));
    expect(r.prompt).toBeNull();
    expect(r.source).toBe('default');
  });

  test('configured file → verbatim contents, source=file', async () => {
    const file = join(dir, 'fidelity.md');
    writeFileSync(file, FIDELITY_PROMPT);
    const r = await resolveExtractAtomsPrompt(
      stubEngine({ 'cycle.extract_atoms.prompt_file': file }),
    );
    expect(r.prompt).toBe(FIDELITY_PROMPT);
    expect(r.source).toBe('file');
    expect(r.path).toBe(file);
  });

  test('relative path resolves against brainDir', async () => {
    writeFileSync(join(dir, 'rel.md'), 'relative prompt body');
    const r = await resolveExtractAtomsPrompt(
      stubEngine({ 'cycle.extract_atoms.prompt_file': 'rel.md' }),
      dir,
    );
    expect(r.prompt).toBe('relative prompt body');
    expect(r.path).toBe(join(dir, 'rel.md'));
  });

  test('~/ expansion reaches the home directory', async () => {
    const homeFile = join(process.env.HOME ?? tmpdir(), '.gbrain-test-prompt-5756.md');
    writeFileSync(homeFile, 'home prompt body');
    try {
      const r = await resolveExtractAtomsPrompt(
        stubEngine({ 'cycle.extract_atoms.prompt_file': '~/.gbrain-test-prompt-5756.md' }),
      );
      expect(r.prompt).toBe('home prompt body');
    } finally {
      rmSync(homeFile, { force: true });
    }
  });

  test('unreadable file → warn + default fallback (never aborts the cycle)', async () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => { writes.push(s); return true; }) as never;
    try {
      const r = await resolveExtractAtomsPrompt(
        stubEngine({ 'cycle.extract_atoms.prompt_file': join(dir, 'nope.md') }),
      );
      expect(r.prompt).toBeNull();
      expect(r.source).toBe('default');
      expect(writes.join('')).toContain('cycle.extract_atoms.prompt_file');
      expect(writes.join('')).toContain('unreadable');
    } finally {
      process.stderr.write = orig;
    }
  });

  test('empty file → warn + default fallback', async () => {
    const file = join(dir, 'empty.md');
    writeFileSync(file, '   \n');
    const r = await resolveExtractAtomsPrompt(
      stubEngine({ 'cycle.extract_atoms.prompt_file': file }),
    );
    expect(r.prompt).toBeNull();
    expect(r.source).toBe('default');
  });
});

describe('prompt reaches the extractor (PGLite wiring)', () => {
  let engine: PGLiteEngine;
  let brainDir: string;
  beforeAll(async () => {
    configureGateway({ env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    brainDir = mkdtempSync(join(tmpdir(), 'atoms-prompt-brain-'));
  });
  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    rmSync(brainDir, { recursive: true, force: true });
  });

  function chatCapture() {
    const seen: ChatOpts[] = [];
    const chat = async (o: ChatOpts): Promise<ChatResult> => {
      seen.push(o);
      return {
        text: `[{"title":"Statute section 4","atom_type":"insight","body":"Liability cap applies only where the contract says so in writing."}]`,
        blocks: [{ type: 'text', text: '' }],
        stopReason: 'end',
        usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-haiku-4-5',
        providerId: 'anthropic',
      };
    };
    return { seen, chat };
  }

  const TRANSCRIPT = {
    filePath: '/fake/statute.txt',
    content: 'transcript content about liability caps',
    contentHash: 'abc123def4567890',
  };

  test('configured prompt_file text reaches chat({system}) and prompt_source=file', async () => {
    const file = join(brainDir, 'fidelity.md');
    writeFileSync(file, FIDELITY_PROMPT);
    await engine.setConfig('cycle.extract_atoms.prompt_file', file);
    try {
      const { seen, chat } = chatCapture();
      const result = await runPhaseExtractAtoms(engine, {
        _transcripts: [TRANSCRIPT],
        _pages: [],
        _chat: chat,
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].system).toBe(FIDELITY_PROMPT);
      expect(result.details?.prompt_source).toBe('file');
    } finally {
      await engine.unsetConfig('cycle.extract_atoms.prompt_file');
    }
  });

  test('no prompt_file → built-in EXTRACT_PROMPT and prompt_source=default', async () => {
    const { seen, chat } = chatCapture();
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ ...TRANSCRIPT, contentHash: 'def456abc7890123' }],
      _pages: [],
      _chat: chat,
    });
    expect(seen[0].system).toBe(EXTRACT_PROMPT);
    expect(result.details?.prompt_source).toBe('default');
  });
});

describe('dream --print-extract-prompt', () => {
  let engine: PGLiteEngine;
  let brainDir: string;
  beforeAll(async () => {
    configureGateway({ env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    brainDir = mkdtempSync(join(tmpdir(), 'atoms-print-brain-'));
  });
  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    rmSync(brainDir, { recursive: true, force: true });
  });

  async function captureRun(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErrWrite = process.stderr.write.bind(process.stderr);
    const origExit = process.exit;
    console.log = ((s?: string) => { out.push(s ?? ''); }) as never;
    process.stderr.write = ((s: string) => { err.push(s); return true; }) as never;
    process.exit = ((code?: number) => { throw new Error(`__exit_${code}`); }) as never;
    try {
      await runDream(engine, args);
    } catch (e) {
      expect(String(e)).toContain('__exit_');
    } finally {
      console.log = origLog;
      process.stderr.write = origErrWrite;
      process.exit = origExit;
    }
    return { stdout: out.join('\n'), stderr: err.join('') };
  }

  test('prints the configured file prompt and exits 0', async () => {
    const file = join(brainDir, 'fidelity.md');
    writeFileSync(file, FIDELITY_PROMPT);
    await engine.setConfig('cycle.extract_atoms.prompt_file', file);
    try {
      const { stdout, stderr } = await captureRun(['--print-extract-prompt', '--dir', brainDir]);
      expect(stdout).toBe(FIDELITY_PROMPT);
      expect(stderr).toContain(`file ${file}`);
    } finally {
      await engine.unsetConfig('cycle.extract_atoms.prompt_file');
    }
  });

  test('prints the built-in default when unset', async () => {
    const { stdout, stderr } = await captureRun(['--print-extract-prompt', '--dir', brainDir]);
    expect(stdout).toBe(EXTRACT_PROMPT);
    expect(stderr).toContain('built-in default');
  });
});
