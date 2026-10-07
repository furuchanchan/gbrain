import type { DreamVerdict, DreamVerdictInput } from '../engine.ts';

/**
 * #6069: how long a cached "unreliable" marker suppresses the paid re-judge.
 * Unreliable verdicts are not real verdicts — the marker exists only to bound
 * re-spend, so it is written with `score: null` (can never satisfy
 * isTriageCacheValid) and expires from the skip path after this window.
 */
export const UNRELIABLE_VERDICT_BACKOFF_MS = 24 * 60 * 60 * 1000;

/** Marker rows carry `unreliable:<kind>` as reasons[0]. */
const UNRELIABLE_MARKER_PREFIX = 'unreliable:';

/** The dream_verdicts row written for a degenerate judgement (#6069). */
export function buildUnreliableMarkerVerdict(
  kind: string,
  reasons: string[],
  model: string,
  triageVersion: number,
): DreamVerdictInput {
  return {
    worth_processing: false,
    reasons: [`${UNRELIABLE_MARKER_PREFIX}${kind}`, ...reasons].slice(0, 5),
    score: null,
    content_type: null,
    segments: [],
    entities: [],
    model,
    triage_version: triageVersion,
  };
}

/**
 * A dream_verdicts row written by the unreliable path (#6069): score is null
 * (never a real-verdict hit), the (triage_version, model) tuple still applies
 * so a model or prompt change re-judges immediately, `staleBefore` busts it
 * like any other row, and judged_at older than the backoff re-judges too.
 */
export function isUnreliableVerdictMarker(
  cached: Pick<DreamVerdict, 'score' | 'triage_version' | 'model' | 'judged_at' | 'reasons'>,
  model: string,
  triageVersion: number,
  staleBefore: Date | undefined,
  nowMs: number,
): boolean {
  if (cached.score !== null || cached.triage_version !== triageVersion || cached.model !== model) return false;
  if (!(cached.reasons?.[0] ?? '').startsWith(UNRELIABLE_MARKER_PREFIX)) return false;
  const judgedMs = Date.parse(cached.judged_at);
  if (!Number.isFinite(judgedMs)) return false;
  if (staleBefore && judgedMs < staleBefore.getTime()) return false;
  return nowMs - judgedMs < UNRELIABLE_VERDICT_BACKOFF_MS;
}

/** The `unreliable:<kind>` suffix a marker row carries, for reports. */
function unreliableMarkerKind(reasons: string[]): string {
  return /^unreliable:(\w+)/.exec(reasons[0] ?? '')?.[1] ?? 'unparseable';
}

/** #6069 marker-hit report: suppressed re-judge — no spend, still counted unreliable. */
export function unreliableMarkerReport(
  filePath: string,
  cached: Pick<DreamVerdict, 'reasons'>,
): { filePath: string; worth: false; score: null; content_type: null; reasons: string[]; cached: true; unreliable: string } {
  return {
    filePath,
    worth: false,
    score: null,
    content_type: null,
    reasons: [...cached.reasons, 're-judge suppressed by 24h backoff'],
    cached: true,
    unreliable: unreliableMarkerKind(cached.reasons),
  };
}
