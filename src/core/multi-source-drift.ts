/**
 * Multi-source drift detection (v0.31.8 — D8 + D17 + OV12 + OV13).
 *
 * Pre-v0.30.3 putPage misrouted multi-source writes from intended source X
 * to (default, slug). The fixwave fixed forward-going writes but explicitly
 * deferred backfilling the misrouted rows. This module surfaces evidence of
 * misroute to operators via `gbrain doctor`.
 *
 * Heuristic (codex OV12 — softened from "is misrouted" to "appears misrouted"):
 * a non-default source X is configured with `local_path`, AND the filesystem
 * at `local_path` contains a markdown file whose slug exists at (default,
 * slug) in the DB but is missing from (X, slug). Two possible causes:
 *   1. Pre-v0.30.3 putPage misroute (the case this check was designed for).
 *   2. Source X never completed initial sync, and the default page is
 *      unrelated content that happens to share the slug.
 * The doctor warning surfaces evidence; the operator decides which cause
 * applies and runs `gbrain sync --source X --full` or `gbrain delete <slug>`
 * accordingly.
 *
 * Implementation notes:
 *  - FS walk handles `.md` AND `.mdx` (codex OV13: matches `src/core/sync.ts`
 *    which treats both as markdown).
 *  - Batched single-query DB lookup (D17): collect all candidate slugs from
 *    the FS walk into one array, then run ONE SELECT against pages with a
 *    VALUES clause. NOT a per-file loop (which would be 20K round trips on
 *    a 10K-file source).
 *  - Time + size bounds: cap the walk at 10K files OR 5s. Bail with a "check
 *    skipped, walk too large" status instead of letting doctor hang.
 *  - Wrapper try/catch around the walk per OV13: ENOENT/EACCES on local_path
 *    yields zero files, NOT a thrown crash that takes down the whole doctor
 *    run.
 *  - #4712: the slug derivation below is `local_path`-relative only, which
 *    is the `'source-root'` slug-root shape (#4342, src/core/sync-anchor.ts).
 *    A source pinned to `'git-root'` mode produces slugs prefixed with its
 *    subdir under the repo root instead — this module has no git-root
 *    discovery of its own, so it CANNOT compute the slug sync actually
 *    produces for such a source. Rather than compare against the wrong
 *    slug (false-positive drift, with delete advice naming an unrelated
 *    page), a git-root-pinned source is skipped entirely and reported via
 *    `git_root_skipped`. True prefix-aware matching is tracked as a
 *    follow-up, not attempted here.
 */

import { readdirSync, lstatSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { BrainEngine } from './engine.ts';
import { pathToSlug } from './sync.ts';
import { readSlugRootMode } from './sync-anchor.ts';

export interface SourceWithPath {
  id: string;
  local_path: string;
}

export interface MisroutedSample {
  slug: string;
  intended_source: string;
  local_path: string;
}

export interface MisroutedResult {
  /** True when the FS walk hit the limit/timeout and the result is partial. */
  walk_truncated: boolean;
  /**
   * Source IDs whose local_path walk was (partly) unreadable — a missing or
   * permission-denied root, or any subdirectory that failed to list. An
   * unreadable walk means zero-or-partial coverage, NOT a clean result.
   */
  unreadable_sources: string[];
  /** Per-source breakdown: slugs that appear at (default, slug) but NOT at (X, slug). */
  count: number;
  sample: MisroutedSample[];
  /**
   * #4712: source IDs skipped because their persisted slug_root_mode is
   * 'git-root' — this check only knows how to derive 'source-root'-shaped
   * (local_path-relative) slugs, so a git-root-pinned source is excluded
   * rather than checked against the wrong slug shape.
   */
  git_root_skipped: string[];
}

const DEFAULT_FILE_LIMIT = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const SAMPLE_LIMIT = 5;

/**
 * Walk a directory tree for `.md` + `.mdx` files. Skips dotfiles (`.git`),
 * `_*.md` files (the existing extract.ts convention), and silently swallows
 * read errors on individual entries. Returns relative paths from `root`.
 *
 * Bounded by `limit` (max files) and `deadlineMs` (epoch ms). Returns early
 * with `truncated=true` if either bound is hit. The root-not-readable case
 * surfaces as `files=[]` with `unreadable=true`; the same flag is set when
 * ANY subdirectory fails to list, so the caller can tell "verified empty"
 * apart from "could not read".
 */
function walkMarkdownAndMdxFiles(
  root: string,
  limit: number,
  deadlineMs: number,
): { files: { relPath: string }[]; truncated: boolean; unreadable: boolean } {
  const files: { relPath: string }[] = [];
  let truncated = false;
  let unreadable = false;
  function walk(d: string): void {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      // Unreadable directory; record it (partial coverage, not "no files")
      // and skip without crashing the whole walk.
      unreadable = true;
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.startsWith('.')) continue;
      // Skip heavy non-content dirs so the walk doesn't exhaust the time
      // budget on dependency/build trees (node_modules can be 50k+ files
      // with zero .md). These are never gbrain page sources.
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build' ||
          entry === '.next' || entry === 'vendor' || entry === 'target') continue;
      const full = join(d, entry);
      let isDir = false;
      try {
        isDir = lstatSync(full).isDirectory();
      } catch {
        unreadable = true;
        continue;
      }
      if (isDir) {
        // Time check on directory descent too, so a deep dependency-free
        // tree still respects the deadline even before any .md is found.
        if (Date.now() >= deadlineMs) { truncated = true; return; }
        walk(full);
        continue;
      }
      const isMd = entry.endsWith('.md') || entry.endsWith('.mdx');
      if (!isMd) continue;
      if (entry.startsWith('_')) continue; // matches extract.ts convention
      files.push({ relPath: relative(root, full) });
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      // Time check is cheap; do it on every push so a slow filesystem can't
      // run unbounded.
      if (Date.now() >= deadlineMs) {
        truncated = true;
        return;
      }
    }
  }
  // Wrap the top-level walk in try/catch so a missing/unreadable root
  // doesn't bubble up to doctor (codex OV13 — pre-fix the readdirSync at
  // the root would throw and crash the whole doctor run).
  try {
    statSync(root); // probe readable; throws ENOENT/EACCES if not
    walk(root);
  } catch {
    // local_path is unreadable; return zero files flagged unreadable so the
    // caller reports "check incomplete" rather than "verified clean".
    unreadable = true;
  }
  return { files, truncated, unreadable };
}

function envBoundedInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * For a list of slugs, query DB for existence at (default, slug) AND at
 * (sourceId, slug) in ONE batched query. Returns a Map<slug, Set<source_id>>.
 *
 * Engine-agnostic: uses executeRaw with a VALUES clause. PGLite + Postgres
 * both support the shape.
 */
async function batchProbeExistence(
  engine: BrainEngine,
  slugs: string[],
  sourceId: string,
): Promise<Map<string, Set<string>>> {
  if (slugs.length === 0) return new Map();
  // Build a positional VALUES clause: ($1::text), ($2), ($3), ...
  const valuePlaceholders = slugs.map((_, i) => `($${i + 1}::text)`).join(', ');
  const sourceParamIdx = slugs.length + 1;
  const sql = `
    WITH candidates(slug) AS (VALUES ${valuePlaceholders})
    SELECT c.slug, p.source_id
    FROM candidates c
    LEFT JOIN pages p
      ON p.slug = c.slug AND p.deleted_at IS NULL
         AND p.source_id IN ('default', $${sourceParamIdx}::text)
    ORDER BY c.slug, p.source_id
  `;
  const rows = await engine.executeRaw<{ slug: string; source_id: string | null }>(
    sql,
    [...slugs, sourceId],
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.slug)) map.set(r.slug, new Set());
    if (r.source_id != null) map.get(r.slug)!.add(r.source_id);
  }
  return map;
}

/**
 * Find pages that appear misrouted from intended source X to source 'default'.
 * For each non-default source with a configured local_path, walk the
 * filesystem and cross-check against the DB.
 *
 * @returns aggregated MisroutedResult across all checked sources. The sample
 *          array is bounded at 5 entries so the doctor message stays scannable.
 */
export async function findMisroutedPages(
  engine: BrainEngine,
  sources: SourceWithPath[],
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<MisroutedResult> {
  // The truncation advice tells operators to tune GBRAIN_DRIFT_LIMIT /
  // GBRAIN_DRIFT_TIMEOUT_MS — actually read them (explicit opts still win).
  const limit = opts.limit ?? envBoundedInt('GBRAIN_DRIFT_LIMIT', DEFAULT_FILE_LIMIT);
  const timeoutMs = opts.timeoutMs ?? envBoundedInt('GBRAIN_DRIFT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const deadlineMs = Date.now() + timeoutMs;

  let totalCount = 0;
  let walkTruncated = false;
  const sample: MisroutedSample[] = [];
  const gitRootSkipped: string[] = [];
  const unreadableSources: string[] = [];

  for (const src of sources) {
    if (src.id === 'default') continue;
    if (!src.local_path) continue;
    if (Date.now() >= deadlineMs) {
      walkTruncated = true;
      break;
    }
    // #4712: local_path-relative slugs are only correct for 'source-root'-
    // pinned sources. A 'git-root' pin means sync produces subdir-prefixed
    // slugs this module doesn't know how to reconstruct — skip rather than
    // compare against a slug shape that will never match.
    const rootMode = await readSlugRootMode(engine, src.id);
    if (rootMode === 'git-root') {
      gitRootSkipped.push(src.id);
      continue;
    }
    const { files, truncated, unreadable } = walkMarkdownAndMdxFiles(src.local_path, limit, deadlineMs);
    if (truncated) walkTruncated = true;
    if (unreadable) unreadableSources.push(src.id);
    if (files.length === 0) continue;

    // Convert FS paths to canonical slugs (lowercased, extension stripped).
    const slugs = Array.from(new Set(files.map(f => pathToSlug(f.relPath))));
    const existenceMap = await batchProbeExistence(engine, slugs, src.id);

    for (const slug of slugs) {
      const present = existenceMap.get(slug);
      if (!present) continue; // missing both — uningested, not misroute
      const hasDefault = present.has('default');
      const hasSource = present.has(src.id);
      // The misroute heuristic: present at default, missing from intended source.
      if (hasDefault && !hasSource) {
        totalCount++;
        if (sample.length < SAMPLE_LIMIT) {
          sample.push({ slug, intended_source: src.id, local_path: src.local_path });
        }
      }
    }
  }

  return { walk_truncated: walkTruncated, count: totalCount, sample, git_root_skipped: gitRootSkipped, unreadable_sources: unreadableSources };
}

export type MultiSourceDriftKind = 'drift' | 'incomplete' | 'nothing_checked' | 'clean';

/**
 * Shared verdict for the local doctor and the remote (thin-client) doctor,
 * which render the same result with surface-specific advice. A truncated or
 * unreadable scan is 'incomplete' — never reported as verified clean. When
 * every candidate source was skipped (git-root pin) or unreadable, no
 * verification ran at all and the verdict is 'nothing_checked'.
 */
export function multiSourceDriftVerdict(
  result: MisroutedResult,
  candidateCount: number,
): { kind: MultiSourceDriftKind; status: 'ok' | 'warn'; incompleteReasons: string[] } {
  const reasons: string[] = [];
  if (result.walk_truncated) reasons.push('FS walk hit limit/timeout');
  if (result.unreadable_sources.length > 0) {
    reasons.push(`unreadable source path(s): ${result.unreadable_sources.join(', ')}`);
  }
  const uncovered = result.git_root_skipped.length + result.unreadable_sources.length;
  if (candidateCount > 0 && uncovered >= candidateCount && result.count === 0) {
    return { kind: 'nothing_checked', status: 'warn', incompleteReasons: reasons };
  }
  if (result.count > 0) return { kind: 'drift', status: 'warn', incompleteReasons: reasons };
  if (reasons.length > 0) return { kind: 'incomplete', status: 'warn', incompleteReasons: reasons };
  if (result.git_root_skipped.length > 0) {
    return { kind: 'clean', status: 'ok', incompleteReasons: reasons };
  }
  return { kind: 'clean', status: 'ok', incompleteReasons: reasons };
}
