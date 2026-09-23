/**
 * #5354 — backup_coverage grades the remote's EFFECT, not its configuration.
 * probeRemoteBranch runs `git ls-remote` on the trusted local compute path:
 *   remote deleted/denied      → 'failing'  (definitive — every push fails)
 *   remote unreachable         → 'unknown'  (offline class, never a false fail)
 *   remote branch absent       → 'failing'  (zero recoverable history)
 *   remote head ≠ local HEAD   → 'unpushed' (currency, verified live)
 *   remote head === HEAD       → 'ok'
 * GBRAIN_BACKUP_REMOTE_PROBE=0 restores the pre-#5354 configuration-only
 * verdict (opt-out for hosts that must never touch the network).
 *
 * Fixtures are real tmp repos + a local bare origin — the probe's file
 * transport needs the documented test escape GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1
 * (same escape the durability paths honor; default 'never' reads a
 * file-protocol refusal as 'unreachable', never a false 'missing').
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrainEngine } from '../src/core/engine.ts';
import { computeBackupCoverage } from '../src/core/backup/coverage.ts';
import {
  __setBackupNagStatePathForTests,
  __setBackupStatusPathForTests,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

const ENV_KEYS = [
  'GBRAIN_HOME',
  'GBRAIN_BACKUP_CHECK',
  'GBRAIN_BACKUP_REMOTE_PROBE',
  'GBRAIN_GIT_ALLOW_FILE_TRANSPORT',
  'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE',
] as const;

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-bkremote-'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GBRAIN_HOME = tmp;
  process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
  __setBackupStatusPathForTests(join(tmp, 'state', 'backup-status.json'));
  __setBackupNagStatePathForTests(join(tmp, 'state', 'backup-nag-state.json'));
});

afterEach(() => {
  __setBackupStatusPathForTests(null);
  __setBackupNagStatePathForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function git(dir: string, args: string[]): void {
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 30_000 },
  );
}

function makeRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: ['ignore', 'ignore', 'ignore'] });
  writeFileSync(join(dir, 'note.md'), '# hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** Repo + local bare origin, pushed with -u (tracking ref exists). */
function makePushedRepo(name: string): { dir: string; bare: string } {
  const dir = makeRepo(name);
  const bare = join(tmp, `${name}-origin.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: ['ignore', 'ignore', 'ignore'] });
  git(dir, ['remote', 'add', 'origin', bare]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  return { dir, bare };
}

function commitMore(dir: string): void {
  writeFileSync(join(dir, 'more.md'), '# more\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'more']);
}

function srcRow(id: string, localPath: string | null) {
  return {
    id,
    name: id,
    local_path: localPath,
    last_commit: null,
    last_sync_at: null,
    config: {},
    created_at: new Date(),
    archived: false,
    newest_content_at: null,
  };
}

function stubEngine(sources: unknown[]): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async (sql: string) => {
      if (sql.includes('FROM pages')) return [{ n: 0 }];
      if (sql.includes('FROM sources')) return sources;
      return [];
    },
  } as unknown as BrainEngine;
}

const assetFor = (s: BackupStatus, id: string) => s.assets.find((a) => a.id === id);

describe('#5354 — probeRemoteBranch grades the remote effect', () => {
  test('reachable remote with matching head → ok', async () => {
    const { dir } = makePushedRepo('healthy');
    const s = await computeBackupCoverage(stubEngine([srcRow('src-healthy', dir)]), {
      localGitProbes: true,
      computedBy: 'doctor',
    });
    const a = assetFor(s, 'src-healthy');
    expect(a?.state).toBe('ok');
    expect(s.totals.failing).toBe(0);
  });

  test('deleted remote → failing (remote_missing), overall warn', async () => {
    const { dir, bare } = makePushedRepo('gone');
    rmSync(bare, { recursive: true, force: true });
    const s = await computeBackupCoverage(stubEngine([srcRow('src-gone', dir)]), {
      localGitProbes: true,
      computedBy: 'doctor',
    });
    const a = assetFor(s, 'src-gone');
    expect(a?.state).toBe('failing');
    expect(a?.detail).toContain('remote_missing');
    expect(s.totals.failing).toBe(1);
    expect(s.overall).toBe('warn');
    // A remote-verification negative is NOT recoverable-on-disk-loss.
    expect(s.totals.recoverable_repos).toBe(0);
  });

  test('remote exists but branch deleted → failing (remote_branch_missing)', async () => {
    const { dir, bare } = makePushedRepo('nobranch');
    git(bare, ['update-ref', '-d', 'refs/heads/main']);
    const s = await computeBackupCoverage(stubEngine([srcRow('src-nobranch', dir)]), {
      localGitProbes: true,
      computedBy: 'doctor',
    });
    const a = assetFor(s, 'src-nobranch');
    expect(a?.state).toBe('failing');
    expect(a?.detail).toContain('remote_branch_missing');
    expect(s.overall).toBe('warn');
  });

  test('ahead of a live remote → unpushed now moves overall to warn', async () => {
    const { dir } = makePushedRepo('ahead');
    commitMore(dir);
    const s = await computeBackupCoverage(stubEngine([srcRow('src-ahead', dir)]), {
      localGitProbes: true,
      computedBy: 'doctor',
    });
    const a = assetFor(s, 'src-ahead');
    expect(a?.state).toBe('unpushed');
    expect(a?.ahead).toBe(1);
    expect(s.totals.unpushed).toBe(1);
    // The issue's aggravating detail: unpushed must move status off ok.
    expect(s.overall).toBe('warn');
  });

  test('unreachable remote → unknown (offline class, never a fabricated fail)', async () => {
    const dir = makeRepo('offline');
    // Port 9 (discard) on loopback refuses instantly — no network needed.
    git(dir, ['remote', 'add', 'origin', 'https://127.0.0.1:9/nonexistent.git']);
    git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const s = await computeBackupCoverage(stubEngine([srcRow('src-offline', dir)]), {
      localGitProbes: true,
      computedBy: 'doctor',
    });
    const a = assetFor(s, 'src-offline');
    expect(a?.state).toBe('unknown');
    expect(a?.detail).toContain('remote_unreachable');
    expect(s.totals.failing).toBe(0);
  });

  test('GBRAIN_BACKUP_REMOTE_PROBE=0 restores configuration-only grading', async () => {
    process.env.GBRAIN_BACKUP_REMOTE_PROBE = '0';
    const { dir, bare } = makePushedRepo('optout');
    rmSync(bare, { recursive: true, force: true });
    const s = await computeBackupCoverage(stubEngine([srcRow('src-optout', dir)]), {
      localGitProbes: true,
      computedBy: 'doctor',
    });
    const a = assetFor(s, 'src-optout');
    // Pre-#5354 behavior: configuration says backed-up, so ok.
    expect(a?.state).toBe('ok');
    expect(s.overall).toBe('ok');
  });

  test('probe-less compute (remote surface) stays untouched', async () => {
    const { dir } = makePushedRepo('remote-surface');
    const s = await computeBackupCoverage(stubEngine([srcRow('src-remote', dir)]), {
      localGitProbes: false,
      computedBy: 'doctor',
    });
    const a = assetFor(s, 'src-remote');
    expect(a?.state).toBe('unknown');
    expect(a?.detail).toBe('probes_skipped');
  });
});
