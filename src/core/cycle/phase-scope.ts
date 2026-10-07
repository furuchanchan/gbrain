import type { CyclePhase } from '../cycle.ts';

/**
 * Phase-scope taxonomy. `runCycle` enforces it for explicit non-default
 * sources: only source phases run there; mixed and global phases run once in
 * the default/global-maintenance lane.
 *
 * - source: safe to parallelize per source.
 * - global: must serialize across the brain.
 * - mixed: reads brain-wide input while writing pages, so it stays in the
 *   default/global-maintenance lane until decomposed.
 */
export type PhaseScope = 'source' | 'global' | 'mixed';

export const PHASE_SCOPE: Record<CyclePhase, PhaseScope> = {
  lint: 'source',
  backlinks: 'source',
  sync: 'source',
  fence_repair: 'global',
  synthesize: 'mixed',
  extract: 'source',
  extract_facts: 'source',
  resolve_symbol_edges: 'global',
  patterns: 'mixed',
  recompute_emotional_weight: 'source',
  consolidate: 'source',
  propose_takes: 'source',
  grade_takes: 'global',
  calibration_profile: 'global',
  drift: 'global',
  edge_contradictions: 'global',
  chronicle: 'global',
  facts_drain: 'global',
  embed: 'global',
  orphans: 'global',
  purge: 'global',
  'schema-suggest': 'source',
  extract_atoms: 'source',
  synthesize_concepts: 'global',
  conversation_facts_backfill: 'source',
  enrich_thin: 'source',
  skillopt: 'global',
};

/** Bounded deterministic phases that alone define source freshness. */
export const SOURCE_FRESHNESS_PHASES: CyclePhase[] = [
  'lint', 'backlinks', 'sync', 'extract', 'extract_facts',
  'recompute_emotional_weight',
];

/**
 * #5673: the database phases a per-source cycle runs for a connector source
 * (google, github). Connector sync runs only from the freshness loop, and a
 * connector cycle has no brain directory, so filesystem phases never run.
 */
export const CONNECTOR_SOURCE_PHASES: CyclePhase[] = ['extract', 'extract_facts', 'recompute_emotional_weight'];

/**
 * #6242: the cycle lock follows the resolved phase set, not the requested
 * source. Any mixed- or global-scoped phase means the run touches brain-wide
 * rows, so it must serialize on the legacy `gbrain-cycle` lock (undefined
 * here → `cycleLockIdFor(undefined)`) — whatever `sourceId` says. A bare
 * `gbrain dream` derives sourceId 'default' and would otherwise take
 * `gbrain-cycle:default` while autopilot's global maintenance holds
 * `gbrain-cycle`, letting synthesize/patterns run twice at once. A
 * source-scoped-only selection keeps its per-source lock so different
 * sources' freshness cycles still overlap, including alongside the
 * autopilot's global maintenance.
 */
export function cycleLockSourceIdFor(
  phases: readonly CyclePhase[],
  sourceId: string | undefined,
): string | undefined {
  return phases.some((p) => PHASE_SCOPE[p] !== 'source') ? undefined : sourceId;
}
