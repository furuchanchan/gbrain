// #5318 — repo probes must be hermetic: an ambient GIT_DIR/GIT_WORK_TREE
// rebinds `git -C <path>` to a different repository, so a valid checkout gets
// rejected as "not a git repository" by both `sources add` and `sync`.
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isInsideGitRepo, hasTrackedContent } from '../src/core/git-remote.ts';
import { discoverGitRoot } from '../src/core/sync-git.ts';

let repoDir: string;
let bogusDir: string;

function git(dir: string, args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-probe-repo-'));
  bogusDir = mkdtempSync(join(tmpdir(), 'gbrain-probe-bogus-'));
  git(repoDir, ['init', '-q']);
  writeFileSync(join(repoDir, 'a.md'), '# a\n');
  git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(repoDir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  // A second repo the ambient env would rebind probes to (has no commits).
  git(bogusDir, ['init', '-q']);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(bogusDir, { recursive: true, force: true });
});

describe('env-scrubbed repo probes (#5318)', () => {
  test('GIT_DIR pointing at a different repo does not rebind the probe', () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = bogusDir;
    try {
      // GIT_DIR set: git ignores -C and opens bogusDir — rev-parse
      // --show-toplevel on bogusDir still succeeds, but --verify HEAD:./
      // (no commits) fails there, so hasTrackedContent would lie without
      // the scrub.
      expect(hasTrackedContent(repoDir)).toBe(true);
      expect(isInsideGitRepo(repoDir)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  test('GIT_DIR+GIT_WORK_TREE pointing elsewhere does not rebind discovery', () => {
    const savedDir = process.env.GIT_DIR;
    const savedTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = bogusDir;
    process.env.GIT_WORK_TREE = bogusDir;
    try {
      // Pre-fix: git opens bogusDir and reports ITS toplevel.
      expect(discoverGitRoot(repoDir)).toContain('gbrain-probe-repo-');
    } finally {
      if (savedDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedDir;
      if (savedTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = savedTree;
    }
  });

  test('routine non-repo miss stays quiet (stderr-hygiene invariant)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'gbrain-probe-plain-'));
    try {
      // The expected `not a git repository` miss must NOT echo git's raw
      // `fatal:` line — operators grep stderr for it as a crash signature.
      expect(() => discoverGitRoot(plain)).toThrow(/Not inside a git repository/);
      expect(() => discoverGitRoot(plain)).not.toThrow(/fatal:|git:/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('unusual probe failure surfaces the real git cause', () => {
    const missing = join(tmpdir(), 'gbrain-probe-no-such-dir-xyz');
    // `git -C` on a nonexistent dir fails with a non-routine message —
    // the friendly error names it so the operator can act.
    expect(() => discoverGitRoot(missing)).toThrow(/\(git: /);
    expect(() => discoverGitRoot(missing)).not.toThrow(/fatal:/);
  });
});
