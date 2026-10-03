/**
 * #1663 — CRAG-style retrieval-confidence gate (the ceiling half of the
 * floor/ceiling redesign).
 *
 * Corrective-RAG's core move: GRADE what retrieval returned before acting on
 * it, and escalate when the evidence is weak instead of confidently handing
 * the caller noise. gbrain's grade is zero-LLM — it reads the honesty
 * signals the pipeline already stamps (T4 evidence, the reranker's
 * cross-encoder score, the autocut weak-top floor):
 *
 *   strong   — rank-1 carries identity/vector evidence (alias_hit,
 *              exact_lookup, exact_title_match, high_vector_match) or the
 *              reranker scored the top at/above the weak-top floor.
 *   moderate — lexically verified top (keyword_exact) but no identity or
 *              calibrated-semantic signal.
 *   weak     — zero results, a reranked top BELOW the weak-top floor
 *              (the #1863 "whole list is low-confidence" shape), an
 *              OR-relaxed keyword top (keyword_relaxed — unless a top-five
 *              row carries the question's entity + attribute words, the
 *              #5919 `keyword_relaxed_rescued` moderate path), or an
 *              unverified weak_semantic top.
 *
 * Consumers: the `query` op attaches the grade (+ query shape) to its
 * retrieval response meta on every call, and — config-gated, default OFF —
 * escalates a weak result once:
 *
 *   search.crag_escalation=true  → one high-ceiling retrieval re-run
 *                                  (expansion + relational + wide limit,
 *                                  autocut off) — keep whichever run grades
 *                                  better.
 *   search.crag_think=true       → still-weak + local caller → run `think`
 *                                  (multi-round gather + synthesis) and
 *                                  attach its answer to the response meta.
 *
 * Pure module: no engine access here — grading reads stamped fields only,
 * so it can never add latency or fail the search path.
 */

import type { SearchResult } from '../types.ts';

export type RetrievalConfidence = 'strong' | 'moderate' | 'weak';

export interface ConfidenceGrade {
  level: RetrievalConfidence;
  /** Machine-stable reason code (enumerated below; additive-only). */
  reason:
    | 'zero_results'
    | 'exact_lookup'
    | 'alias_hit'
    | 'exact_title_match'
    | 'high_vector_match'
    | 'rerank_top'
    | 'rerank_top_below_floor'
    | 'keyword_exact_top'
    | 'keyword_relaxed_top'
    | 'keyword_relaxed_rescued'
    | 'weak_semantic_top'
    | 'decide_evidence';
  /** Rank-1 evidence label when present (auditability). */
  top_evidence?: string;
  /** Rank-1 cross-encoder score when the reranker ran. */
  top_rerank_score?: number;
}

/**
 * Default weak-top floor for the rerank-score check. Matches autocut's
 * `search.autocut_min_top` default (the #1863 calibration): below it the
 * cross-encoder itself says the best candidate is a poor match.
 */
export const DEFAULT_CRAG_MIN_TOP = 0.2;

export function gradeRetrievalConfidence(
  results: SearchResult[],
  opts: {
    minTopScore?: number;
    /** `ignoreDecideEvidence`: the deterministic grade (S4's agreement rule excludes the S3-derived input). */
    ignoreDecideEvidence?: boolean;
    /**
     * The query text — enables the #5919 relaxed-top rescue: an OR-relaxed
     * rank-1 alone is not verification, but when a top-five row covers every
     * capitalized entity token of the question AND at least one of its
     * remaining content words (or their >=3-letter acronym, e.g. "annual
     * recurring revenue" -> `arr`), an answer-bearing chunk is in the list
     * and the grade recovers to `moderate`. Unanswerable questions stay
     * weak: a sibling attribute's chunk never carries the asked entity, and
     * the entity's own page never carries the missing attribute. Omitted ->
     * the rescue does not run (callers without the query text keep the
     * wave-7 behavior).
     */
    queryText?: string;
  } = {},
): ConfidenceGrade {
  if (results.length === 0) return { level: 'weak', reason: 'zero_results' };
  const top = results[0];
  const floor = typeof opts.minTopScore === 'number' ? opts.minTopScore : DEFAULT_CRAG_MIN_TOP;

  // Identity-tier signals win outright — retrieval FOUND the named thing.
  if (top.exact_lookup !== undefined) {
    return { level: 'strong', reason: 'exact_lookup', top_evidence: top.evidence };
  }
  if (top.alias_hit === true || top.evidence === 'alias_hit') {
    return { level: 'strong', reason: 'alias_hit', top_evidence: top.evidence };
  }
  if (top.evidence === 'exact_title_match') {
    return { level: 'strong', reason: 'exact_title_match', top_evidence: top.evidence };
  }
  if (top.evidence === 'high_vector_match') {
    return { level: 'strong', reason: 'high_vector_match', top_evidence: top.evidence };
  }

  // System One S3 (only stamped when the slot acted): the top kept candidate cleared the evidence threshold.
  if (!opts.ignoreDecideEvidence && top.decide_evidence?.clears) {
    return { level: 'strong', reason: 'decide_evidence', top_evidence: top.evidence };
  }

  // Calibrated cross-encoder signal when the reranker ran (System One rubric levels are not calibrated).
  if (typeof top.rerank_score === 'number' && Number.isFinite(top.rerank_score) && top.rerank_score_kind !== 'rubric') {
    return top.rerank_score >= floor
      ? { level: 'strong', reason: 'rerank_top', top_evidence: top.evidence, top_rerank_score: top.rerank_score }
      : { level: 'weak', reason: 'rerank_top_below_floor', top_evidence: top.evidence, top_rerank_score: top.rerank_score };
  }

  // No reranker: fall back to the T4 evidence contract. An OR-relaxed
  // lexical top matched some query terms, not the query (gbrain-evals A4-2:
  // 120 of 120 unanswerable questions had one at rank 1).
  if (top.keyword_relaxed === true) {
    if (opts.queryText !== undefined && relaxedTopRescued(results, opts.queryText)) {
      return { level: 'moderate', reason: 'keyword_relaxed_rescued', top_evidence: top.evidence };
    }
    return { level: 'weak', reason: 'keyword_relaxed_top', top_evidence: top.evidence };
  }
  if (top.evidence === 'keyword_exact') {
    return { level: 'moderate', reason: 'keyword_exact_top', top_evidence: top.evidence };
  }
  return { level: 'weak', reason: 'weak_semantic_top', top_evidence: top.evidence };
}

/** #5919 — the rescue only looks inside the returned top five. */
const RELAXED_RESCUE_DEPTH = 5;

/**
 * Question scaffolding words — stripped before a word counts as question
 * content. Deliberately small (interrogatives, auxiliaries, articles,
 * quantifiers): attribute-bearing words like `employees`, `months`,
 * `runway` MUST stay, since they are what an answer chunk must carry
 * beside the entity name.
 */
const QUERY_SCAFFOLD_WORDS: ReadonlySet<string> = new Set([
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'does', 'do', 'did',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'and', 'or',
  'many', 'much', 'there', 'its', 'it', 'any', 'have', 'has',
]);

const tokenize = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

/**
 * Split the question into entity tokens (capitalized words after the first
 * word — the named thing asked about) and attribute tokens (the remaining
 * content words — what is asked of it).
 */
function questionTokenSets(queryText: string): { entity: Set<string>; attribute: Set<string> } {
  const entity = new Set<string>();
  const attribute = new Set<string>();
  const raw = queryText.split(/\s+/);
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i].replace(/[^a-zA-Z0-9]/g, '');
    if (w.length <= 1) continue;
    const lower = w.toLowerCase();
    if (i > 0 && /^[A-Z]/.test(w)) { entity.add(lower); continue; }
    if (!QUERY_SCAFFOLD_WORDS.has(lower)) attribute.add(lower);
  }
  return { entity, attribute };
}

function relaxedTopRescued(results: SearchResult[], queryText: string): boolean {
  const { entity, attribute } = questionTokenSets(queryText);
  if (entity.size === 0 && attribute.size === 0) return false;
  // Acronym bridge for paraphrased attributes: the question says
  // "annual recurring revenue", the stored sentence writes "ARR".
  const acronym = attribute.size >= 2 ? [...attribute].map((w) => w[0]).join('') : null;
  for (const r of results.slice(0, RELAXED_RESCUE_DEPTH)) {
    const words = new Set(tokenize(typeof r.chunk_text === 'string' ? r.chunk_text : ''));
    if (![...entity].every((w) => words.has(w))) continue;
    // No named entity in the question: a row must cover the full attribute
    // content, not just share a word with it.
    if (entity.size === 0) {
      if (attribute.size > 0 && [...attribute].every((w) => words.has(w))) return true;
      continue;
    }
    if ([...attribute].some((w) => words.has(w))) return true;
    if (acronym !== null && acronym.length >= 3 && words.has(acronym)) return true;
  }
  return false;
}

/** Meta block the `query` op attaches under `retrieval.crag`. */
export interface CragMetaBlock {
  confidence: RetrievalConfidence;
  reason: ConfidenceGrade['reason'];
  query_shape: 'factual' | 'open';
  top_rerank_score?: number;
  /** Present when the high-ceiling retrieval re-run fired. */
  escalated?: boolean;
  escalated_confidence?: RetrievalConfidence;
  /** Still weak after (or without) escalation → the honest next move. */
  escalate_to_think?: boolean;
  /** Present when search.crag_think ran the think pipeline. */
  think?: {
    answer: string;
    citations: number;
    synthesis_status?: string;
    model?: string;
  };
}

/**
 * Decision helper for the op layer: should the high-ceiling retrieval
 * re-run fire? Kept pure/exported so the policy is unit-testable.
 * Retrieval-side escalation only pays off when a better index sweep could
 * plausibly contain the answer — which is true for BOTH shapes, but the
 * op only re-runs when the first pass didn't already use the high-ceiling
 * knobs (`callerExpanded`) — otherwise the re-run would pay a second
 * query-expansion LLM call + a second rerank pass over a near-identical
 * candidate set (#4610: this guard was documented here long before it was
 * implemented; the production call site now passes the resolved expand
 * flag, so default-shape `query` callers — expand on unless explicitly
 * disabled — no longer double-spend on every weak grade).
 */
export function shouldEscalateRetrieval(
  grade: ConfidenceGrade,
  opts: { enabled: boolean; alreadyEscalated?: boolean; callerExpanded?: boolean },
): boolean {
  return opts.enabled && !opts.alreadyEscalated && !opts.callerExpanded && grade.level === 'weak';
}

/** Rank a grade for better-of-two comparison after an escalated re-run. */
export function confidenceRank(level: RetrievalConfidence): number {
  switch (level) {
    case 'strong': return 2;
    case 'moderate': return 1;
    case 'weak': return 0;
  }
}
