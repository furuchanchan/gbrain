/**
 * skill-query.ts — #6471: lexical ranking for `list_skills`/`find_skills`.
 *
 * Trigger routing today is all-or-nothing: a trigger phrase must be a
 * substring of the normalized intent. An agent that paraphrases a task
 * gets no match and falls back to reading the whole catalog. This scorer
 * keeps keyword matches first (a trigger phrase inside the query wins
 * outright, same rule as structuralRouteMatch) and falls back to token
 * overlap over the skill's description, example queries and name, so a
 * query that shares no words with any trigger still ranks on description.
 *
 * Pure lexical scoring — no embeddings, no LLM, same determinism as the
 * trigger index. Load-bearing in both catalog paths:
 *   - schema_version 2 (`listSharedSkills`): scores the already
 *     audience/policy-filtered snapshot, so remote callers see only the
 *     skills they could already list.
 *   - schema_version 1 (`buildSkillCatalog`): scores host-repo entries
 *     including `example_queries` frontmatter.
 */

import { normalizeText } from './routing-eval.ts';

export interface SkillQueryCandidate {
  /** Catalog entry key (slug, qualified_id or name) for the report. */
  key: string;
  name: string;
  description?: string;
  triggers?: string[];
  exampleQueries?: string[];
}

export interface SkillQueryMatch {
  kind: 'trigger' | 'description' | 'example_queries' | 'name';
  /** The trigger or description line that matched. */
  text: string;
}

export interface SkillQueryScore {
  score: number;
  matched: SkillQueryMatch | null;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that',
  'i', 'you', 'we', 'me', 'my', 'your', 'our', 'how', 'what', 'when',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'please',
]);

function queryTokens(query: string): string[] {
  return normalizeText(query)
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function overlap(queryTokens: string[], corpus: string): number {
  if (!queryTokens.length) return 0;
  const corpusTokens = new Set(normalizeText(corpus).split(/\s+/));
  let hit = 0;
  for (const t of queryTokens) if (corpusTokens.has(t)) hit++;
  return hit / queryTokens.length;
}

/**
 * Score one skill against a natural-language query.
 *   - A normalized trigger phrase that is a substring of the normalized
 *     query wins outright (score 1.x): keyword routing still wins.
 *   - Otherwise the score is the best token-coverage fraction across
 *     description (0.7 weight cap), example queries (0.8) and name (0.9).
 */
export function scoreSkillQuery(query: string, skill: SkillQueryCandidate): SkillQueryScore {
  const normalizedQuery = normalizeText(query);
  const tokens = queryTokens(query);
  if (!normalizedQuery || !tokens.length) return { score: 0, matched: null };

  for (const trigger of skill.triggers ?? []) {
    const phrase = normalizeText(trigger);
    if (phrase.length >= 3 && normalizedQuery.includes(phrase)) {
      return { score: 1 + Math.min(phrase.length / 100, 0.5), matched: { kind: 'trigger', text: trigger } };
    }
  }

  let best: SkillQueryScore = { score: 0, matched: null };
  const consider = (kind: SkillQueryMatch['kind'], text: string, weight: number) => {
    const s = overlap(tokens, text) * weight;
    if (s > best.score) best = { score: s, matched: { kind, text } };
  };
  for (const eq of skill.exampleQueries ?? []) consider('example_queries', eq, 0.8);
  if (skill.description) consider('description', skill.description, 0.7);
  consider('name', skill.name.replaceAll(/[-_]/g, ' '), 0.9);

  // Fractional phrase bump: two adjacent query tokens appearing in order
  // anywhere in the description is a stronger signal than bag-of-words.
  if (best.matched && best.matched.kind !== 'name' && tokens.length >= 2) {
    for (let i = 0; i + 1 < tokens.length; i++) {
      const pair = `${tokens[i]} ${tokens[i + 1]}`;
      const matched = best.matched.text;
      if (normalizeText(matched).includes(pair)) { best = { score: best.score + 0.05, matched: best.matched }; break; }
    }
  }
  return best;
}

/** Score + rank a catalog against a query; drops zero-score entries. Stable name tie-break. */
export function rankSkillQuery<T extends SkillQueryCandidate>(
  query: string,
  skills: readonly T[],
): Array<T & { score: number; matched: SkillQueryMatch | null }> {
  return skills
    .map(skill => ({ ...skill, ...scoreSkillQuery(query, skill) }))
    .filter(skill => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export interface QueryRoutingReport {
  readonly candidates: number;
  readonly totalCases: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly k: number;
  readonly details: readonly {
    intent: string;
    expected: string;
    top: string | null;
    hit: boolean;
  }[];
}

/**
 * Hit@k for the ranked `list_skills` query path over routing-eval
 * fixtures. The report's trigger-only baseline stays in
 * `runRoutingEval`'s top-1 accuracy; this is the "trigger plus query"
 * number the eval reports alongside it.
 */
export function runQueryHitRate(
  fixtures: readonly { intent: string; expected_skill: string | null }[],
  candidates: readonly SkillQueryCandidate[],
  k = 3,
): QueryRoutingReport {
  const positives = fixtures.filter(f => f.expected_skill !== null);
  const details = positives.map(f => {
    const ranked = rankSkillQuery(f.intent, candidates);
    const expected = f.expected_skill!;
    const hit = ranked.slice(0, k).some(r => r.key === expected);
    return { intent: f.intent, expected, top: ranked[0]?.key ?? null, hit };
  });
  const hits = details.filter(d => d.hit).length;
  return {
    candidates: candidates.length,
    totalCases: positives.length,
    hits,
    hitRate: positives.length === 0 ? 0 : hits / positives.length,
    k,
    details,
  };
}
