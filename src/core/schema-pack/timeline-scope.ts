// #5828 — brain_score timeline-component scope.
//
// The 15-point timeline component of brain_score grades only pages whose
// type's primitive in the active pack is `entity` or `temporal` — pages
// that describe someone or something with a history, or events.
// Reference documents (`media`, `concept`, `annotation` primitives:
// notes, writing, guides, imported notes) describe no event, so they
// have nothing honest to put on a timeline — the only way a
// document-heavy brain could lift the component was stamping a fake
// "page created" row on every document.
//
// Documents drop out of BOTH the numerator and the denominator. Types
// the active pack does NOT declare keep the historical graded behaviour,
// so a brain changes only when its pack actually says a type is a
// document. The orphan and link components and the entity-scoped
// `timeline_coverage` metric keep the all-linkable scope unchanged —
// this module is used ONLY for the 15-point density component.

import type { BrainEngine } from '../engine.ts';
import type { SchemaPackManifest } from './manifest-v1.ts';

export interface TimelineScoreScope {
  /** Every type name the pack declares. */
  declared: Set<string>;
  /** Declared types whose primitive is `entity` or `temporal`. */
  graded: Set<string>;
}

export function timelineScoreScopeFromPack(
  pack: Pick<SchemaPackManifest, 'page_types'>,
): TimelineScoreScope {
  const declared = new Set<string>();
  const graded = new Set<string>();
  for (const pt of pack.page_types) {
    declared.add(pt.name);
    if (pt.primitive === 'entity' || pt.primitive === 'temporal') {
      graded.add(pt.name);
    }
  }
  return { declared, graded };
}

/**
 * Is `type` graded by the timeline component? Undeclared types keep the
 * historical graded behaviour — only a type the pack explicitly calls a
 * document primitive is exempt.
 */
export function isTimelineScoreGraded(type: string, scope: TimelineScoreScope): boolean {
  return !scope.declared.has(type) || scope.graded.has(type);
}

/**
 * Resolve the active pack's timeline-score scope for a local engine.
 * `null` = pack unresolvable — callers degrade to the historical
 * all-linkable denominator rather than failing the health check.
 * The pack-resolution closure stays a lazy import: this module is the
 * shared engine-side seam, and pack loading must never become a
 * getHealth-startup dependency (same justification class as the lazy
 * gateway lookups in the engines' initSchema).
 */
export async function timelineScoreScopeForEngine(
  engine: Pick<BrainEngine, 'getConfig'>,
  opts?: { sourceId?: string },
): Promise<TimelineScoreScope | null> {
  const { loadActivePackForLocalEngine } = await import('./best-effort.ts');
  const pack = await loadActivePackForLocalEngine(engine, { sourceId: opts?.sourceId });
  return pack ? timelineScoreScopeFromPack(pack.manifest) : null;
}

/** `scope === null` degrades to every row — the historical all-linkable denominator. */
export function filterTimelineGradedRows<T extends { type: string }>(
  rows: T[],
  scope: TimelineScoreScope | null,
): T[] {
  return scope === null ? rows : rows.filter(row => isTimelineScoreGraded(row.type, scope));
}
