import { execFileSync } from 'child_process';
import { lstatSync } from 'fs';
import { join } from 'path';

/**
 * Return every path visible to git from `dir` (tracked + untracked-non-ignored),
 * respecting .gitignore, .git/info/exclude, and global git excludes — without
 * lstat filtering, so symlinks and gitlinks stay visible to callers that must
 * classify them (e.g. the canonical worktree manifest, which refuses
 * symlinks). Returns null when `dir` is not inside a git work tree or git is
 * unavailable, so callers can keep their existing filesystem-walk fallback.
 */
export function collectGitVisiblePaths(
  dir: string,
  acceptRelPath: (relPath: string) => boolean,
): string[] | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }

  const ignoredTracked = new Set<string>();
  try {
    const ignoredStdout = execFileSync(
      'git',
      ['-C', dir, 'ls-files', '-ci', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const rel of ignoredStdout.split('\0')) {
      if (rel) ignoredTracked.add(rel);
    }
  } catch {
    // Best effort: older Git or unusual worktrees still get the standard list.
  }

  const paths: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (!rel) continue;
    if (ignoredTracked.has(rel)) continue;
    const normalizedRel = rel.replace(/\\/g, '/');
    if (!acceptRelPath(normalizedRel)) continue;
    paths.push(join(dir, rel));
  }

  return paths.sort();
}

/**
 * Return files visible to git from `dir` — the subset of
 * collectGitVisiblePaths that lstats as regular files (no symlinks, no
 * gitlink dirs). Null on the same conditions.
 */
export function collectGitVisibleFiles(
  dir: string,
  acceptRelPath: (relPath: string) => boolean,
): string[] | null {
  const paths = collectGitVisiblePaths(dir, acceptRelPath);
  if (paths === null) return null;

  const files: string[] = [];
  for (const full of paths) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    files.push(full);
  }

  return files;
}
