/**
 * [ENG-8] Facts default-visibility resolver — the ONE helper behind every
 * "caller didn't say" visibility decision.
 *
 * The 'private' default used to be duplicated at four sites (backstop.ts
 * minion-payload + pipeline, operations.ts extract_facts + ontology_propose),
 * and the op-layer ternaries coerced ANY non-'world' value — including unset —
 * to 'private' before a config default could run. This module centralizes the
 * ladder:
 *
 *   explicit caller value ('private' | 'world')  — always wins
 *     → config key `facts.default_visibility`     — operator-set brain default
 *       → 'private'                               — fail-closed floor
 *
 * Security note (stated intent, per the eng review): setting
 * `facts.default_visibility = world` widens what remote/MCP callers can read
 * back through the hot-memory meta hook and turn_context — that is the
 * DELIBERATE single-principal posture bootstrap configures (CX-P1.1), not a
 * leak. Invalid or unreadable config always resolves 'private'.
 *
 * #5857 — read-side counterpart of `search.remote_private_pages`: brains that
 * already hold private facts (everything written before
 * `facts.default_visibility = world`, plus private rows a remote put_page
 * preserve round-trips) had no operator path to let remote callers read them.
 * `resolveExposePrivateFacts` is the single trust+config resolver for that
 * widening:
 *
 *   remote === false                      → true (trusted local sees all)
 *   GBRAIN_REMOTE_PRIVATE_FACTS=1         → true (incident escape hatch)
 *   config search.remote_private_facts ∈ {visible,true,1}
 *                                         → true (operator opt-in)
 *   otherwise                             → false (world-only, fail-closed)
 *
 * Callers resolve once per op and thread the boolean into the fact-row
 * filters (`visibility: ['world']` opts, findTrajectory's remote filter,
 * include_private gates) and into sanitizeRemoteBody's `keepPrivateFacts`
 * for remote-read `## Facts` fences.
 */

import type { BrainEngine } from '../engine.ts';

export type FactVisibility = 'private' | 'world';

export const FACTS_DEFAULT_VISIBILITY_KEY = 'facts.default_visibility';

export const REMOTE_PRIVATE_FACTS_KEY = 'search.remote_private_facts';

const FACTS_EXPOSE_CACHE_TTL_MS = 30_000;
let factsExposeCache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();

/** Test helper: drop the per-engine expose-cache. */
export function __resetFactsExposeCacheForTests(): void {
  factsExposeCache = new WeakMap();
}

/**
 * May this caller read `visibility: private` facts? `remote` follows the repo
 * trust convention: strictly `false` is the trusted local CLI; anything else
 * is untrusted unless the operator opted in. Config lookups are cached 30s per
 * engine; a failed lookup counts as "not opted in" (fail-closed).
 */
export async function resolveExposePrivateFacts(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<boolean> {
  if (remote === false) return true; // trusted local CLI sees everything
  if (process.env.GBRAIN_REMOTE_PRIVATE_FACTS === '1') return true; // escape hatch
  const hit = factsExposeCache.get(engine);
  let expose: boolean;
  if (hit && Date.now() - hit.at < FACTS_EXPOSE_CACHE_TTL_MS) {
    expose = hit.expose;
  } else {
    try {
      const v = await engine.getConfig(REMOTE_PRIVATE_FACTS_KEY);
      expose = v === 'visible' || v === 'true' || v === '1';
    } catch {
      expose = false; // config unreadable → enforce (fail-closed)
    }
    factsExposeCache.set(engine, { at: Date.now(), expose });
  }
  return expose;
}

/**
 * Resolve the brain-level default visibility for facts writes when the caller
 * did not specify one. Reads `facts.default_visibility` via engine.getConfig
 * (the extract.ts:isFactsExtractionEnabled precedent). Returns 'world' only on
 * an explicit, well-formed opt-in; anything else — unset, invalid, or a config
 * read failure — fails closed to 'private'.
 */
export async function resolveDefaultVisibility(engine: BrainEngine): Promise<FactVisibility> {
  try {
    const val = await engine.getConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    if (val == null) return 'private';
    return val.trim().toLowerCase() === 'world' ? 'world' : 'private';
  } catch {
    return 'private'; // config read failure must never widen visibility
  }
}

/**
 * Op-layer param resolution shared by extract_facts and ontology_propose.
 * Contract (the :4468-ternary fix):
 *   - explicit 'world'  → 'world'  (caller wins)
 *   - explicit 'private'→ 'private' (caller wins — even over a world default)
 *   - unset (null/undefined) → resolveDefaultVisibility(engine)
 *   - any other garbage value → 'private' (fail-closed, matches the historic
 *     coercion for invalid input; only genuinely-unset reaches the config).
 */
export async function resolveVisibilityParam(
  engine: BrainEngine,
  value: unknown,
): Promise<FactVisibility> {
  if (value === 'world') return 'world';
  if (value === 'private') return 'private';
  if (value == null) return resolveDefaultVisibility(engine);
  return 'private';
}
