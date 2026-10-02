/**
 * #5465: `gbrain hook user-prompt` with a transcript_path that is inside the
 * projects root but does not exist yet (Claude Code writes transcripts
 * asynchronously — a fresh session's first turn can name a not-yet-created
 * file). Confinement now reports `absent` for that case, and the lane treats
 * it as "no prior context" — the prompt alone still goes through turn-context
 * assembly, exactly like a payload with no transcript_path or a 0-byte file.
 *
 * Asserted without a live serve: an absent-contained path must NOT degrade
 * `transcript_*` — the lane proceeds and fails later at config resolution
 * (`no_pglite_path`, the same point the no-transcript control reaches). An
 * absent path OUTSIDE the root stays fail-closed `transcript_outside_*`.
 *
 * Lane: serial. Run: `bash scripts/run-serial-tests.sh test/hook-userprompt-absent-transcript-5465.serial.test.ts`
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook, readHeartbeatTail, type HookHeartbeatEntry } from '../src/commands/hook.ts';

const ENV_KEYS = [
  'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS',
  'GBRAIN_HOOK_LANE', 'GBRAIN_STOP_PUSH', 'GBRAIN_STOP_PUSH_DEBOUNCE_MIN',
  'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'GH_TOKEN', 'GITHUB_TOKEN',
  'GBRAIN_MEMORABLE',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-hk-absent-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function collectStdout(): { io: { write: (s: string) => void }; get: () => string } {
  let buf = '';
  return { io: { write: (s: string) => { buf += s; } }, get: () => buf };
}

async function lastHeartbeat(): Promise<HookHeartbeatEntry | undefined> {
  const tail = await readHeartbeatTail(1);
  return tail[0];
}

const payload = (transcript_path: string | undefined) =>
  JSON.stringify({
    prompt: 'When did Example Person first get in touch?',
    session_id: 'absent-5465',
    cwd: tmp,
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    ...(transcript_path !== undefined ? { transcript_path } : {}),
  });

describe('user-prompt absent transcript (#5465)', () => {
  // The reporter's arm (b): not-yet-created .jsonl inside the projects root.
  // Pre-fix: transcript_unreadable abort. Post-fix: proceeds prompt-only and
  // reaches the same later degrade as the no-transcript control.
  test('absent leaf inside the projects root proceeds past confinement', async () => {
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: payload(join(projRoot, 'p1', 'fresh.jsonl')),
        cwd: tmp,
        transcriptRoot: projRoot,
      }),
    ).toBe(0);
    const hb = await lastHeartbeat();
    expect(hb?.event).toBe('user-prompt');
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('no_pglite_path');
    expect(hb?.reason ?? '').not.toMatch(/^transcript_/);
  });

  // Reporter's controls (c)+(d): identical posture for a 0-byte transcript
  // and for no transcript_path at all — the absent case must degrade at the
  // same downstream point, not earlier.
  test('controls: 0-byte file and missing field reach the same degrade', async () => {
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const empty = join(projRoot, 'p1', 'empty.jsonl');
    writeFileSync(empty, '');
    for (const tp of [empty, undefined]) {
      const out = collectStdout();
      expect(
        await runHook(['user-prompt'], {
          ...out.io,
          stdin: payload(tp),
          cwd: tmp,
          transcriptRoot: projRoot,
        }),
      ).toBe(0);
      expect((await lastHeartbeat())?.reason).toBe('no_pglite_path');
    }
  });

  // Fail-closed stays: an absent path outside the root (directly, or via a
  // symlinked parent that escapes it) still aborts the event.
  test('absent path outside the root still aborts the event', async () => {
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: payload(join(outside, 'x.jsonl')),
        cwd: tmp,
        transcriptRoot: projRoot,
      }),
    ).toBe(0);
    const hb = await lastHeartbeat();
    expect(hb?.outcome).toBe('degraded');
    expect(hb?.reason).toBe('transcript_outside_projects_dir');
    expect(out.get()).not.toContain('hookSpecificOutput');
  });

  test('absent leaf under a symlinked parent escaping the root aborts', async () => {
    const projRoot = join(tmp, 'projects');
    mkdirSync(join(projRoot, 'p1'), { recursive: true });
    const escape = join(tmp, 'escape');
    mkdirSync(escape);
    symlinkSync(escape, join(projRoot, 'linked'));
    const out = collectStdout();
    expect(
      await runHook(['user-prompt'], {
        ...out.io,
        stdin: payload(join(projRoot, 'linked', 'x.jsonl')),
        cwd: tmp,
        transcriptRoot: projRoot,
      }),
    ).toBe(0);
    expect((await lastHeartbeat())?.reason).toBe('transcript_outside_projects_dir');
  });
});
