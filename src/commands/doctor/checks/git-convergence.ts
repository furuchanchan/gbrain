/**
 * git_convergence doctor check (#5063, suggestion 1).
 *
 * The sync checkout can diverge from origin while every existing signal
 * stays green: `bootstrap_push_health` only weighs a dirty/ahead tree when
 * the last tracked push is already >48h stale, and nothing else measures
 * the checkout against the remote-tracking ref at all. This check probes
 * every git-backed checkout (sync.repo_path plus each source's local_path)
 * on every run and reports the raw convergence facts — dirty file count,
 * ahead/behind against the stored upstream, and how old the divergence is —
 * warn past 1h, fail past 24h.
 *
 * Local-only probes: no `git fetch` (doctor must not hit the network); the
 * stored remote-tracking ref is the comparison base, so a checkout stale
 * purely because origin moved reads `behind`, not `ok`.
 *
 * The verdict logic is pure (`assessGitConvergence`) and the git probing is
 * injectable (`probeGitRoot` takes a runner) so tests drive both without a
 * real repository. Emits ONE check naming the worst root, or nothing when
 * no git checkout is configured — a DB-only brain keeps a clean doctor.
 */
import { execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const WARN_MS = 3600_000;
const FAIL_MS = 24 * 3600_000;
const GIT_TIMEOUT_MS = 10_000;
/** Cap on modified paths statted for dirty-age — a mass-modified tree needs no full walk to know it is old or young. */
const DIRTY_STAT_LIMIT = 200;

export interface GitRootProbe {
  /** Repo root path that was probed. */
  root: string;
  /** Human label for messages ('sync.repo_path' or 'source:<id>'). */
  label: string;
  /** Modified/staged/untracked paths reported by `git status --porcelain`. */
  dirty: number;
  /** Commits on HEAD not on the upstream ref. */
  ahead: number;
  /** Commits on the upstream ref not on HEAD. */
  behind: number;
  /** Milliseconds since the OLDEST unpushed commit (null when ahead === 0). */
  divergedMs: number | null;
  /** Milliseconds since the oldest modified file's mtime (null when clean / unstatable). */
  dirtyAgeMs: number | null;
  /** True when no upstream ref resolved — ahead/behind are then -1 and unknown. */
  upstreamless: boolean;
}

type GitRunner = (root: string, args: string[]) => string | null;

const defaultGitRunner: GitRunner = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).toString().trim();
  } catch {
    return null;
  }
};

/**
 * Resolve the upstream ref for ahead/behind: the configured `@{u}` first,
 * then `origin/<current branch>` (covers a branch pushed under a differently
 * named remote ref or fetched as origin/<branch> without an upstream set).
 * Returns null when nothing resolves — callers report 'upstreamless' rather
 * than guessing at full-history counts.
 */
function resolveUpstream(root: string, run: GitRunner): string | null {
  if (run(root, ['rev-parse', '--verify', '@{u}']) !== null) return '@{u}';
  const branch = run(root, ['branch', '--show-current']);
  if (branch && run(root, ['rev-parse', '--verify', `origin/${branch}`]) !== null) return `origin/${branch}`;
  return null;
}

/**
 * Probe one repo root. Returns null when the path is not inside a git
 * worktree (plain directory sources, missing checkouts — converged by
 * construction as far as THIS check is concerned).
 */
export function probeGitRoot(root: string, label: string, run: GitRunner = defaultGitRunner): GitRootProbe | null {
  if (!existsSync(root)) return null;
  if (run(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;

  const porcelain = run(root, ['status', '--porcelain']) ?? '';
  const dirtyPaths = porcelain
    .split('\n')
    .filter(line => line.length > 3)
    .map(line => {
      const p = line.slice(3);
      // rename entries: `XY old -> new` — the surviving path is what ages the dirt.
      const arrow = p.indexOf(' -> ');
      return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, '');
    });
  let oldestDirtyMs: number | null = null;
  for (const rel of dirtyPaths.slice(0, DIRTY_STAT_LIMIT)) {
    try {
      const st = statSync(join(root, rel));
      const age = Date.now() - st.mtimeMs;
      if (oldestDirtyMs === null || age > oldestDirtyMs) oldestDirtyMs = age;
    } catch { /* stat failure is not a verdict input */ }
  }

  const upstream = resolveUpstream(root, run);
  let ahead = -1;
  let behind = -1;
  let divergedMs: number | null = null;
  if (upstream) {
    const counts = run(root, ['rev-list', '--count', '--left-right', `${upstream}...HEAD`]);
    if (counts) {
      const [b, a] = counts.split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    }
    if (ahead > 0) {
      // Oldest unpushed commit's committer date: `git log` walks newest-first,
      // so the last line's timestamp is where the divergence began.
      const stamps = run(root, ['log', '--format=%ct', `${upstream}..HEAD`]);
      if (stamps) {
        const cts = stamps.split('\n').map(Number).filter(Number.isFinite);
        if (cts.length > 0) divergedMs = Date.now() - Math.min(...cts) * 1000;
      }
    }
  }

  return {
    root, label,
    dirty: dirtyPaths.length,
    ahead, behind,
    divergedMs,
    dirtyAgeMs: oldestDirtyMs,
    upstreamless: upstream === null,
  };
}

/** Turn the probed states into the single emitted check. Pure — unit-tested directly. */
export function assessGitConvergence(states: GitRootProbe[]): Check | null {
  if (states.length === 0) return null;
  const hours = (ms: number) => `${Math.floor(ms / 3600_000)}h`;
  const describe = (s: GitRootProbe): string => {
    const bits: string[] = [];
    if (s.dirty > 0) bits.push(`${s.dirty} dirty file(s)${s.dirtyAgeMs !== null ? `, oldest ${hours(s.dirtyAgeMs)}` : ''}`);
    if (s.ahead > 0) bits.push(`${s.ahead} ahead${s.divergedMs !== null ? ` (${hours(s.divergedMs)} since divergence)` : ''}`);
    if (s.behind > 0) bits.push(`${s.behind} behind`);
    if (s.upstreamless) bits.push('no upstream ref');
    if (bits.length === 0) return `${s.label}: converged`;
    return `${s.label}: ${bits.join(', ')}`;
  };

  const divergedLong = (s: GitRootProbe) =>
    (s.ahead > 0 && s.divergedMs !== null && s.divergedMs > FAIL_MS) ||
    (s.dirtyAgeMs !== null && s.dirtyAgeMs > FAIL_MS);
  const diverged = (s: GitRootProbe) =>
    (s.ahead > 0 && (s.divergedMs === null || s.divergedMs > WARN_MS)) ||
    (s.dirtyAgeMs !== null && s.dirtyAgeMs > WARN_MS) ||
    s.behind > 0 ||
    // No resolvable upstream = convergence unverifiable, not converged.
    s.upstreamless;

  const fails = states.filter(divergedLong);
  if (fails.length > 0) {
    return {
      name: 'git_convergence',
      status: 'fail',
      message:
        `checkout diverged from origin >24h — ${fails.map(describe).join('; ')}. ` +
        `Commit and push the pending work (\`git -C <root> add -A && git commit && git push\`), ` +
        `or run \`gbrain sources push\` so the system of record stops drifting.`,
    };
  }
  const warns = states.filter(diverged);
  if (warns.length > 0) {
    return {
      name: 'git_convergence',
      status: 'warn',
      message: `${warns.map(describe).join('; ')} — reconcile with \`gbrain sources push\` (or \`git pull\` for the behind case).`,
    };
  }
  const young = states.filter(s => s.dirty > 0 || s.ahead > 0 || s.behind > 0);
  return {
    name: 'git_convergence',
    status: 'ok',
    message: young.length === 0
      ? `${states.length} checkout(s) converged with origin`
      : `converged — fresh (<1h) changes pending: ${young.map(describe).join('; ')}`,
  };
}

async function gatherRoots(engine: BrainEngine): Promise<{ root: string; label: string }[]> {
  const roots: { root: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (root: string | null | undefined, label: string) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    roots.push({ root, label });
  };
  try {
    add(await engine.getConfig('sync.repo_path'), 'sync.repo_path');
  } catch { /* config read failure must not break doctor */ }
  try {
    const sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
    );
    for (const s of sources) add(s.local_path, `source:${s.id}`);
  } catch { /* a broken sources table is reported by its own check */ }
  return roots;
}

async function runGitConvergence(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  const roots = await gatherRoots(engine);
  const states = roots.map(r => probeGitRoot(r.root, r.label)).filter((s): s is GitRootProbe => s !== null);
  const check = assessGitConvergence(states);
  if (check) checks.push(check);
  return checks;
}

export const gitConvergenceEntry: DoctorEntry = {
  name: 'git_convergence',
  emits: ['git_convergence'],
  run: runGitConvergence,
};
