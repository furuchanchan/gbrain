/**
 * git-remote durability helpers (v0.42.44): divergenceSafePull, detectDefaultBranch,
 * pushProbe, isWorkingTreeDirty. Real git against local bare remotes.
 *
 * Local file transport is enabled via GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 (the
 * documented escape hatch the durability paths honor).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  divergenceSafePull, detectDefaultBranch, pushProbe, isWorkingTreeDirty,
} from '../src/core/git-remote.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }).trim();
}

let root: string;
let bare: string;

/** A bare origin + a working clone with one commit on `main`. */
function makePair(): { bare: string; work: string } {
  const b = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', b], { stdio: 'ignore' });
  const w = mkdtempSync(join(root, 'work-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', b, w], { stdio: 'ignore' });
  git(w, 'config', 'user.email', 't@t.t');
  git(w, 'config', 'user.name', 'tester');
  writeFileSync(join(w, 'README.md'), 'init\n');
  git(w, 'add', 'README.md');
  git(w, 'commit', '-qm', 'init');
  git(w, 'push', '-q', 'origin', 'main');
  // Set origin/HEAD so detectDefaultBranch can resolve it.
  try { git(w, 'remote', 'set-head', 'origin', 'main'); } catch { /* */ }
  return { bare: b, work: w };
}

function secondClone(b: string): string {
  const w = mkdtempSync(join(root, 'work2-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', b, w], { stdio: 'ignore' });
  git(w, 'config', 'user.email', 'u@u.u');
  git(w, 'config', 'user.name', 'tester2');
  return w;
}

beforeAll(() => { process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1'; });
afterAll(() => { delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT; });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gd-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('detectDefaultBranch', () => {
  test('resolves origin/HEAD', () => {
    const { work } = makePair();
    expect(detectDefaultBranch(work)).toBe('main');
  });
  test('falls back to main when nothing resolves', () => {
    const empty = mkdtempSync(join(root, 'bare-')); // not a git repo
    expect(detectDefaultBranch(empty)).toBe('main');
  });
});

describe('isWorkingTreeDirty', () => {
  test('false when clean, true after an edit', () => {
    const { work } = makePair();
    expect(isWorkingTreeDirty(work)).toBe(false);
    writeFileSync(join(work, 'README.md'), 'changed\n');
    expect(isWorkingTreeDirty(work)).toBe(true);
  });
});

describe('divergenceSafePull', () => {
  test('up_to_date when already current', () => {
    const { work } = makePair();
    expect(divergenceSafePull(work, 'main').status).toBe('up_to_date');
  });

  test('advanced when origin has a new commit', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'b.txt'), 'b\n');
    git(other, 'add', 'b.txt'); git(other, 'commit', '-qm', 'b'); git(other, 'push', '-q', 'origin', 'main');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('advanced');
    expect(existsSync(join(work, 'b.txt'))).toBe(true);
  });

  test('skipped_dirty when the working tree is dirty', () => {
    const { work } = makePair();
    writeFileSync(join(work, 'README.md'), 'local edit\n');
    expect(divergenceSafePull(work, 'main').status).toBe('skipped_dirty');
  });

  test('rebases local commits over origin', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'remote.txt'), 'r\n');
    git(other, 'add', 'remote.txt'); git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q', 'origin', 'main');
    // local commit on a DIFFERENT file → clean rebase
    writeFileSync(join(work, 'local.txt'), 'l\n');
    git(work, 'add', 'local.txt'); git(work, 'commit', '-qm', 'local');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('advanced');
    expect(existsSync(join(work, 'remote.txt'))).toBe(true);
    expect(existsSync(join(work, 'local.txt'))).toBe(true);
  });

  test('conflict_aborted leaves NO rebase state', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'README.md'), 'remote version\n');
    git(other, 'add', 'README.md'); git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q', 'origin', 'main');
    // local commit touching the SAME line → rebase conflict
    writeFileSync(join(work, 'README.md'), 'local version\n');
    git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'local');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('conflict_aborted');
    // The "never mid-rebase" invariant:
    expect(existsSync(join(work, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(work, '.git', 'rebase-apply'))).toBe(false);
    // Working tree is usable (HEAD is the local commit, not a conflicted state).
    expect(gitIn(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  test('#5429 — pullStrategy=merge merges tip-equivalent divergence rebase cannot replay', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    // origin moves to "current".
    writeFileSync(join(other, 'page.md'), 'current\n');
    git(other, 'add', 'page.md'); git(other, 'commit', '-qm', 'origin current'); git(other, 'push', '-q', 'origin', 'main');
    // local: an intermediate snapshot, then a tip matching origin's content —
    // rebase conflicts on the intermediate replay; merge is clean.
    writeFileSync(join(work, 'page.md'), 'intermediate\n');
    git(work, 'add', 'page.md'); git(work, 'commit', '-qm', 'intermediate');
    writeFileSync(join(work, 'page.md'), 'current\n');
    git(work, 'add', 'page.md'); git(work, 'commit', '-qm', 'current');

    git(work, 'config', '--local', 'gbrain.pullStrategy', 'merge');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('advanced');
    // Merge commit keeps both histories: parents = local tip + origin tip.
    const parents = gitIn(work, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
    expect(parents.length).toBe(2);
    expect(gitIn(work, 'rev-parse', 'origin/main')).toBe(parents[1]);
    expect(existsSync(join(work, '.git', 'MERGE_HEAD'))).toBe(false);
    // A follow-up pull is a no-op.
    expect(divergenceSafePull(work, 'main').status).toBe('up_to_date');
  });

  test('#5429 — merge strategy fails closed on a real content conflict', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'README.md'), 'remote version\n');
    git(other, 'add', 'README.md'); git(other, 'commit', '-qm', 'remote'); git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(work, 'README.md'), 'local version\n');
    git(work, 'add', 'README.md'); git(work, 'commit', '-qm', 'local');
    const headBefore = gitIn(work, 'rev-parse', 'HEAD');
    git(work, 'config', '--local', 'gbrain.pullStrategy', 'merge');
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('conflict_aborted');
    if (out.status === 'conflict_aborted') expect(out.detail).toContain('--no-rebase');
    expect(existsSync(join(work, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(gitIn(work, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(work, 'status', '--porcelain')).toBe('');
  });

  test('#5429 — unset pullStrategy keeps rebase + never autostashes', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    writeFileSync(join(other, 'page.md'), 'current\n');
    git(other, 'add', 'page.md'); git(other, 'commit', '-qm', 'origin current'); git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(work, 'page.md'), 'intermediate\n');
    git(work, 'add', 'page.md'); git(work, 'commit', '-qm', 'intermediate');
    writeFileSync(join(work, 'page.md'), 'current\n');
    git(work, 'add', 'page.md'); git(work, 'commit', '-qm', 'current');
    git(work, 'config', '--local', 'rebase.autoStash', 'true');
    // No gbrain.pullStrategy → rebase replays "intermediate" and conflicts.
    const out = divergenceSafePull(work, 'main');
    expect(out.status).toBe('conflict_aborted');
    expect(existsSync(join(work, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(work, '.git', 'rebase-apply'))).toBe(false);
    expect(gitIn(work, 'stash', 'list')).toBe('');
  });
});

describe('pushProbe', () => {
  test('ok against a writable remote', () => {
    const { work } = makePair();
    expect(pushProbe(work, 'main')).toEqual({ ok: true });
  });

  test('not ok when origin is unreachable', () => {
    const { work } = makePair();
    git(work, 'remote', 'set-url', 'origin', join(root, 'does-not-exist.git'));
    const r = pushProbe(work, 'main');
    expect(r.ok).toBe(false);
  });

  test('redactDetail scrubs a token from the failure detail', () => {
    const { work } = makePair();
    git(work, 'remote', 'set-url', 'origin', join(root, 'nope-ghp_SECRETTOKEN.git'));
    const r = pushProbe(work, 'main', { redactDetail: (s) => s.replaceAll('ghp_SECRETTOKEN', '***') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail.includes('ghp_SECRETTOKEN')).toBe(false);
  });
});
