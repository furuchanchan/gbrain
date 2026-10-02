/**
 * #5063 — the `git_convergence` doctor check surfaces a checkout diverged
 * from origin (dirty / ahead / behind + divergence age) that
 * `bootstrap_push_health` cannot see until the push is already >48h stale.
 *
 * Verdict logic is tested against the pure `assessGitConvergence`; the git
 * probing path is tested both with an injected runner and against a real
 * temp repository (init → clone → diverge).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  assessGitConvergence,
  probeGitRoot,
  type GitRootProbe,
} from '../src/commands/doctor/checks/git-convergence.ts';

const H = 3600_000;
const state = (over: Partial<GitRootProbe>): GitRootProbe => ({
  root: '/repo', label: 'sync.repo_path',
  dirty: 0, ahead: 0, behind: 0, divergedMs: null, dirtyAgeMs: null, upstreamless: false,
  ...over,
});

describe('#5063 assessGitConvergence verdicts', () => {
  test('no states → no check emitted', () => {
    expect(assessGitConvergence([])).toBeNull();
  });

  test('all converged → ok', () => {
    const c = assessGitConvergence([state({}), state({ root: '/r2', label: 'source:wiki' })]);
    expect(c!.status).toBe('ok');
  });

  test('fresh (<1h) ahead → still ok but names the pending work', () => {
    const c = assessGitConvergence([state({ ahead: 3, divergedMs: 30 * 60_000 })]);
    expect(c!.status).toBe('ok');
    expect(c!.message).toContain('3 ahead');
  });

  test('ahead >1h → warn; >24h → fail', () => {
    expect(assessGitConvergence([state({ ahead: 5, divergedMs: 2 * H })])!.status).toBe('warn');
    expect(assessGitConvergence([state({ ahead: 368, divergedMs: 72 * H })])!.status).toBe('fail');
  });

  test('old dirty tree (>24h) → fail even with zero ahead', () => {
    const c = assessGitConvergence([state({ dirty: 30, dirtyAgeMs: 30 * H })]);
    expect(c!.status).toBe('fail');
    expect(c!.message).toContain('30 dirty file(s)');
  });

  test('behind → warn (checkout stale vs origin, needs pull)', () => {
    expect(assessGitConvergence([state({ behind: 4 })])!.status).toBe('warn');
  });

  test('no upstream ref → warn (convergence unverifiable, not ok)', () => {
    const c = assessGitConvergence([state({ ahead: -1, behind: -1, upstreamless: true })]);
    expect(c!.status).toBe('warn');
    expect(c!.message).toContain('no upstream');
  });
});

describe('#5063 probeGitRoot', () => {
  test('non-git path → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g5063-'));
    try {
      expect(probeGitRoot(dir, 'x')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('injected runner: parses porcelain count + left-right counts + oldest stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g5063i-'));
    const calls: string[] = [];
    const run = (_root: string, args: string[]): string | null => {
      calls.push(args.join(' '));
      const key = args.join(' ');
      if (key === 'rev-parse --is-inside-work-tree') return 'true';
      if (key === 'rev-parse --verify @{u}') return 'deadbeef';
      if (key === 'rev-list --count --left-right @{u}...HEAD') return '2\t5';
      if (key === 'log --format=%ct @{u}..HEAD') return '1700000000\n1700001000';
      if (key === 'status --porcelain') return ' M a.md\n?? b.md';
      return null;
    };
    try {
      const s = probeGitRoot(dir, 'sync.repo_path', run);
      expect(s).not.toBeNull();
      expect(s!.ahead).toBe(5);
      expect(s!.behind).toBe(2);
      expect(s!.dirty).toBe(2);
      expect(s!.divergedMs).toBeGreaterThan(0);
      expect(s!.upstreamless).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('real temp repo: converged clone → ok-state, then diverge → ahead counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'g5063r-'));
    try {
      const seed = join(dir, 'seed');
      const remote = join(dir, 'remote.git');
      const local = join(dir, 'local');
      execFileSync('git', ['init', '-q', '-b', 'master', seed]);
      execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty']);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'master', remote]);
      execFileSync('git', ['-C', seed, 'push', '-q', remote, 'HEAD:master']);
      execFileSync('git', ['clone', '-q', remote, local]);

      const converged = probeGitRoot(local, 'sync.repo_path');
      expect(converged).not.toBeNull();
      expect(converged!.ahead).toBe(0);
      expect(converged!.dirty).toBe(0);
      expect(converged!.upstreamless).toBe(false);

      // Diverge: a local commit + a dirty file → ahead 1, dirty 1.
      execFileSync('git', ['-C', local, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local', '--allow-empty']);
      writeFileSync(join(local, 'dirty.md'), 'x');
      const diverged = probeGitRoot(local, 'sync.repo_path');
      expect(diverged!.ahead).toBe(1);
      expect(diverged!.dirty).toBe(1);
      expect(diverged!.divergedMs).not.toBeNull();

      const check = assessGitConvergence([diverged!]);
      expect(check!.status).toBe('ok'); // <1h — named but not warned
      expect(check!.message).toContain('1 ahead');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
