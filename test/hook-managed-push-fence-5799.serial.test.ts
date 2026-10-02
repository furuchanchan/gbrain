/**
 * #5799: a managed canonical worktree must never spawn the legacy
 * `gbrain sources push` — the guard refuses it by design, so every spawn
 * could only produce a refused-push status record and a sticky "push is
 * FAILING" notice. The hooks detect the managed root (engine-free: on-disk
 * markers + the durable managed-roots registry), skip the spawn, and record
 * the distinct `push_managed_fenced` reason; fenced records (new `fenced`
 * flag or legacy `writer_coordinator_required` reasons) never feed the
 * failure surfaces (banner, SessionStart note, doctor, [D20] retry bypass).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook, readHeartbeatTail, type HookHeartbeatEntry } from '../src/commands/hook.ts';
import {
  isManagedFencedPushEntry,
  pushStatusPathForRoot,
  readPushStatusForRoot,
  readPushStatuses,
  summarizePushStatuses,
  workspacePush,
} from '../src/core/workspace-push.ts';
import { isManagedFilesystemPath } from '../src/core/persistence/filesystem-guard.ts';
import { writeReceipt } from '../src/core/bootstrap/format.ts';
import type { RepoReceipt } from '../src/core/bootstrap/repo.ts';

const ENV_KEYS = [
  'GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS',
  'GBRAIN_STOP_PUSH', 'GBRAIN_STOP_PUSH_DEBOUNCE_MIN', 'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_REMOTE_SESSION_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'GBRAIN_MEMORABLE',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-mpf-'));
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

const home = () => join(tmp, '.gbrain');

function collectStdout(): { io: { write: (s: string) => void }; get: () => string } {
  let buf = '';
  return { io: { write: (s: string) => { buf += s; } }, get: () => buf };
}

async function lastHeartbeat(): Promise<HookHeartbeatEntry | undefined> {
  const tail = await readHeartbeatTail(1);
  return tail[0];
}

const INITIALIZED_MANIFEST = {
  format_version: 1,
  initialized: true,
  agent_name: 'test-agent',
  created_by: 'test',
  created_at: '2026-01-01T00:00:00.000Z',
  source_id: 'workspace',
};

function initGitRepoWithDirtyTree(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'untracked-work.txt'), 'unsaved work\n');
}

/** Same repo-phase-complete gate the push-gate tests use — but with a
 * non-github repo_url so the binding uses repoPhaseComplete's exact-equality
 * branch. A github URL is rewritten by insteadOf URL rewrites in some dev
 * environments (a git proxy), which would make every push defer regardless of
 * the change under test. */
function markRepoPhaseComplete(repo: string): void {
  const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const repoUrl = 'https://example.com/alice/boot-repo';
  try {
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin'], { stdio: 'ignore' });
  } catch {
    /* no origin yet */
  }
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', repoUrl]);
  mkdirSync(join(home(), 'bootstrap'), { recursive: true });
  writeReceipt(home(), {
    receipt_version: 1,
    workspace_dir: toplevel,
    source_id: 'workspace',
    agent_name: 'test-agent',
    created_at: '2026-01-01T00:00:00.000Z',
    created_by: 'test',
    brain_created_by_bootstrap: false,
    created_paths: [],
    registrations: [],
    repo_url: repoUrl,
  } as RepoReceipt);
}

function bootRepo(name: string): string {
  const repo = join(tmp, name);
  initGitRepoWithDirtyTree(repo);
  writeFileSync(join(repo, 'agent.json'), JSON.stringify(INITIALIZED_MANIFEST, null, 2) + '\n');
  markRepoPhaseComplete(repo);
  return repo;
}

/** The durable marker recordManagedRoots writes into the git metadata dir. */
function markManaged(repo: string): void {
  writeFileSync(
    join(repo, '.git', 'gbrain-managed.json'),
    JSON.stringify({ version: 1, managed: true, brain_id: '00000000-0000-0000-0000-000000000000' }) + '\n',
  );
}

function stopIo(repo: string, spawned: string[]) {
  return {
    write: () => {},
    spawnPush: (root: string) => { spawned.push(root); },
    stdin: JSON.stringify({ session_id: 'sess-managed-push', cwd: repo }),
  };
}

describe('managed filesystem detection [#5799]', () => {
  test('isManagedFilesystemPath: git-metadata marker → true, plain repo → false', () => {
    const repo = join(tmp, 'detect');
    initGitRepoWithDirtyTree(repo);
    expect(isManagedFilesystemPath(repo)).toBe(false);
    markManaged(repo);
    expect(isManagedFilesystemPath(repo)).toBe(true);
  });
});

describe('managed worktree: hooks never spawn the fenced legacy push [#5799]', () => {
  test('session-start on a managed dirty bootstrap workspace: no spawn, no unpushed-work note, heartbeat push_managed_fenced', async () => {
    const repo = bootRepo('managed-start');
    markManaged(repo);
    const spawned: string[] = [];
    const out = collectStdout();
    expect(
      await runHook(['session-start'], {
        ...out.io,
        spawnPush: (root: string) => { spawned.push(root); },
        stdin: '',
        cwd: repo,
      }),
    ).toBe(0);
    expect(spawned).toEqual([]);
    expect(out.get()).not.toContain('Unpushed work');
    expect(out.get()).not.toContain('FAILING');
    expect((await lastHeartbeat())?.reason).toBe('push_managed_fenced');
  });

  test('session-end backstop on a managed workspace: no spawn, no push-status file written', async () => {
    const repo = bootRepo('managed-end');
    markManaged(repo);
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const spawned: string[] = [];
    await runHook(['session-end'], {
      write: () => {},
      spawnPush: (root: string) => { spawned.push(root); },
      stdin: JSON.stringify({ session_id: 'sess-managed-end', cwd: repo }),
    });
    expect(spawned).toEqual([]);
    expect(readPushStatusForRoot(toplevel)).toBeNull();
  });

  test('per-turn stop push on a managed workspace: no spawn, heartbeat push_managed_fenced, no stop-push state written', async () => {
    const repo = bootRepo('managed-stop');
    markManaged(repo);
    const spawned: string[] = [];
    expect(await runHook(['stop'], stopIo(repo, spawned))).toBe(0);
    expect(spawned).toEqual([]);
    expect((await lastHeartbeat())?.reason).toBe('push_managed_fenced');
  });

  test('CONTROL — a dirty NON-managed bootstrap workspace still spawns (fence does not over-match)', async () => {
    const repo = bootRepo('unmanaged-start');
    const spawned: string[] = [];
    const out = collectStdout();
    await runHook(['session-start'], {
      ...out.io,
      spawnPush: (root: string) => { spawned.push(root); },
      stdin: '',
      cwd: repo,
    });
    expect(spawned).toHaveLength(1);
  });
});

describe('managed-fenced push-status records never feed the failure surfaces [#5799]', () => {
  test('workspacePush on a managed root refuses and records fenced:true — summarize reports no failure', async () => {
    const repo = bootRepo('managed-refuse');
    markManaged(repo);
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    await expect(workspacePush({ dir: repo })).rejects.toThrow();
    const entry = readPushStatusForRoot(toplevel);
    expect(entry?.ok).toBe(false);
    expect(entry?.fenced).toBe(true);
    expect(isManagedFencedPushEntry(entry!)).toBe(true);
    expect(summarizePushStatuses(readPushStatuses()).failing).toEqual([]);
  });

  test('legacy refused record (no fenced flag, writer_coordinator_required reason) is also not a failure — sticky notice clears', async () => {
    const repo = bootRepo('managed-legacy');
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    writeFileSync(
      pushStatusPathForRoot(toplevel),
      JSON.stringify({
        ts: new Date().toISOString(),
        ok: false,
        reason: 'writer_coordinator_required: This file belongs to a managed canonical worktree.',
        repoRoot: toplevel,
      }) + '\n',
      { mode: 0o600 },
    );
    expect(summarizePushStatuses(readPushStatuses()).failing).toEqual([]);
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: repo });
    expect(out.get()).not.toContain('FAILING');
    expect(out.get()).not.toContain('NOTICE: the background workspace push');
  });

  test('CONTROL — a real failure record still surfaces FAILING on session-start', async () => {
    const repo = bootRepo('unmanaged-fail');
    const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    writeFileSync(
      pushStatusPathForRoot(toplevel),
      JSON.stringify({
        ts: new Date().toISOString(),
        ok: false,
        reason: 'refused_visibility: origin is not private',
        repoRoot: toplevel,
      }) + '\n',
      { mode: 0o600 },
    );
    const out = collectStdout();
    await runHook(['session-start'], { ...out.io, stdin: '', cwd: repo, spawnPush: () => {} });
    expect(readFileSync(pushStatusPathForRoot(toplevel), 'utf8')).toContain('refused_visibility');
    expect(out.get()).toContain('FAILING');
  });
});
