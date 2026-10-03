/**
 * #5941 — codex SessionStart / UserPromptSubmit context lanes.
 *
 * The writer manages all three events: each gets its own hooks.json group
 * (fresh install appends LAST, re-run replaces IN PLACE — foreign indexes
 * never shift) and its own trusted_hash inside the one managed config.toml
 * block. The context commands are synchronous `env … hook <event>` (stdout
 * is the injected context) and bake NO GBRAIN_SOURCE — the source resolves
 * from the payload cwd's .gbrain-source at runtime (hookSourceId).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexContextCommand,
  codexTrustHash,
  removeCodexHooks,
  writeCodexHooks,
} from '../src/core/bootstrap/codex-hooks.ts';
import { hookSourceId } from '../src/commands/hook.ts';
import { withEnv } from './helpers/with-env.ts';

let dir: string;
let hooksPath: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-cdx-ctx-'));
  hooksPath = join(dir, 'hooks.json');
  configPath = join(dir, 'config.toml');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BIN = '/usr/local/bin/gbrain';

function readHooks(): {
  description?: string;
  hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
} {
  return JSON.parse(readFileSync(hooksPath, 'utf8'));
}

describe('writeCodexHooks — the three managed events', () => {
  test('fresh write lands SessionEnd + SessionStart + UserPromptSubmit groups and one trust block with three entries', () => {
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(true);
    expect(res.trustKey).toBe(`${hooksPath}:session_end:0:0`);
    expect(res.trustKeys).toEqual([
      `${hooksPath}:session_end:0:0`,
      `${hooksPath}:session_start:0:0`,
      `${hooksPath}:user_prompt_submit:0:0`,
    ]);

    const doc = readHooks();
    expect(doc.description).toContain('gbrain');
    const se = doc.hooks!.SessionEnd![0]!.hooks[0]!;
    const ss = doc.hooks!.SessionStart![0]!.hooks[0]!;
    const up = doc.hooks!.UserPromptSubmit![0]!.hooks[0]!;
    expect(se.command).toContain('hook session-end --harness codex');
    expect(se.command).toContain('nohup'); // capture lane still detaches
    expect(se.timeout).toBe(3);
    expect(ss.command).toBe(`env GBRAIN_HOOK_LANE=harness ${BIN} hook session-start`);
    expect(up.command).toBe(`env GBRAIN_HOOK_LANE=harness ${BIN} hook user-prompt --harness codex`);
    expect(ss.timeout).toBe(15);
    expect(up.timeout).toBe(15);
    // No baked source on ANY lane — runtime resolution only [OV2].
    for (const h of [se, ss, up]) expect(h.command).not.toContain('GBRAIN_SOURCE');

    const cfg = readFileSync(configPath, 'utf8');
    expect(cfg.match(/gbrain:codex-hooks-trust \(managed/g)).toHaveLength(1);
    for (const k of res.trustKeys!) {
      expect(cfg).toContain(`[hooks.state.${JSON.stringify(k)}]`);
    }
    // The hashed identities are per-event (the event_name and timeout differ).
    expect(cfg).toContain(`trusted_hash = ${JSON.stringify(codexTrustHash(se.command, 'SessionEnd'))}`);
    expect(cfg).toContain(`trusted_hash = ${JSON.stringify(codexTrustHash(ss.command, 'SessionStart'))}`);
    expect(cfg).toContain(`trusted_hash = ${JSON.stringify(codexTrustHash(up.command, 'UserPromptSubmit'))}`);
    expect(codexTrustHash(ss.command, 'SessionStart')).not.toBe(codexTrustHash(ss.command, 'SessionEnd'));
  });

  test('re-run replaces each lane in place: still one group per event, one block, three hashes', () => {
    writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(true);
    expect(res.replacedPrior).toBe(true);
    const doc = readHooks();
    expect(doc.hooks!.SessionEnd!).toHaveLength(1);
    expect(doc.hooks!.SessionStart!).toHaveLength(1);
    expect(doc.hooks!.UserPromptSubmit!).toHaveLength(1);
    const cfg = readFileSync(configPath, 'utf8');
    expect(cfg.match(/gbrain:codex-hooks-trust \(managed/g)).toHaveLength(1);
    expect(cfg.match(/trusted_hash/g)).toHaveLength(3);
  });

  test('foreign groups in the context lanes keep their positions and are named in notes', () => {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'my-own-start', timeout: 2 }] }] },
    }));
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(true);
    expect(res.trustKeys).toContain(`${hooksPath}:session_start:1:0`); // ours AFTER the foreign group
    const doc = readHooks();
    expect(doc.hooks!.SessionStart![0]!.hooks[0]!.command).toBe('my-own-start');
    expect(doc.hooks!.SessionStart![1]!.hooks[0]!.command).toContain('hook session-start');
    expect(res.notes.join(' ')).toContain('foreign SessionStart group(s) preserved');
  });

  test('a foreign trust entry for a CONTEXT key is refused the same as session_end', () => {
    writeFileSync(configPath, `[hooks.state."${hooksPath}:session_start:0:0"]\ntrusted_hash = "sha256:foreign"\n`);
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('foreign_trust_entry');
    expect(existsSync(hooksPath)).toBe(false);
  });

  test('upgrading an old SessionEnd-only install adds the context lanes without touching the session-end group index', () => {
    // A pre-#5941 install: session_end group index 0 with a matching trust
    // entry inside our managed block. Re-running must keep :0:0 for
    // session_end (same command shape → same trust) and append the new lanes.
    writeFileSync(hooksPath, JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: `old ${'hook session-end --harness codex'}`, timeout: 3 }] }] },
    }));
    const res = writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    expect(res.ok).toBe(true);
    expect(res.trustKey).toBe(`${hooksPath}:session_end:0:0`);
    const doc = readHooks();
    expect(doc.hooks!.SessionEnd!).toHaveLength(1);
    expect(doc.hooks!.SessionStart!).toHaveLength(1);
    expect(doc.hooks!.UserPromptSubmit!).toHaveLength(1);
  });
});

describe('removeCodexHooks — all lanes', () => {
  test('strips every managed group and the whole trust block; foreign content survives', () => {
    writeFileSync(configPath, `[hooks.state."x:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:user-owned"\n`);
    writeCodexHooks({ gbrainBin: BIN, hooksPath, configPath });
    const res = removeCodexHooks({ hooksPath, configPath });
    expect(res.removed).toBe(true);
    const doc = readHooks();
    expect(doc.hooks?.SessionEnd).toBeUndefined();
    expect(doc.hooks?.SessionStart).toBeUndefined();
    expect(doc.hooks?.UserPromptSubmit).toBeUndefined();
    const cfg = readFileSync(configPath, 'utf8');
    expect(cfg).toContain('sha256:user-owned');
    expect(cfg).not.toContain('gbrain:codex-hooks-trust');
  });
});

describe('buildCodexContextCommand', () => {
  test('synchronous env-prefixed command — no stdin capture, no detach', () => {
    const cmd = buildCodexContextCommand(BIN, 'session-start');
    expect(cmd).toBe(`env GBRAIN_HOOK_LANE=harness ${BIN} hook session-start`);
    expect(cmd).not.toContain('nohup');
    expect(cmd).not.toContain('mktemp');
  });

  test('a bin path with spaces is quoted', () => {
    const cmd = buildCodexContextCommand('/opt/my tools/gbrain', 'user-prompt --harness codex');
    expect(cmd).toContain(`'/opt/my tools/gbrain'`);
    expect(cmd).toContain('hook user-prompt --harness codex');
  });
});

describe('hookSourceId — runtime source for the context lanes (#5941 option a)', () => {
  test('resolves a .gbrain-source pin by walking up from the payload cwd', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'sub', 'dir'), { recursive: true });
    writeFileSync(join(repo, '.gbrain-source'), 'my-vault\n');
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      expect(hookSourceId(join(repo, 'sub', 'dir'))).toBe('my-vault');
    });
  });

  test('GBRAIN_SOURCE env still wins when set', async () => {
    writeFileSync(join(dir, '.gbrain-source'), 'dotfile-source\n');
    await withEnv({ GBRAIN_SOURCE: 'env-source' }, async () => {
      expect(hookSourceId(dir)).toBe('env-source');
    });
  });

  test('no pin and no env → undefined (unscoped context, never an error)', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      expect(hookSourceId(dir)).toBeUndefined();
    });
  });

  test('an invalid env value degrades to undefined instead of throwing', async () => {
    await withEnv({ GBRAIN_SOURCE: 'INVALID SOURCE!' }, async () => {
      expect(hookSourceId(dir)).toBeUndefined();
    });
  });
});
