/**
 * `pages.source_path` rows written on Windows by the pre-managed sync carry
 * backslash separators (`people\alice.md`), while every git-derived sync
 * entry path is forward-slash. Comparisons normalise only on win32 — a
 * backslash is a legitimate POSIX filename character (and `git ls-tree`
 * reports it literally), so unconditional rewriting would wrongly collapse
 * two distinct files there. Mirrors the #2828 and reconcile-state.ts
 * (`chr(92)` under the same platform gate) handling.
 */
export function storedSourcePath(path: string): string {
  return process.platform === 'win32' ? path.replace(/\\/g, '/') : path;
}
