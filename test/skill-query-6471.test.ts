/**
 * #6471: `list_skills` gains an optional `query` that ranks the
 * caller-visible catalog over name, description, triggers and
 * example_queries. Trigger substring matches still win outright; a query
 * sharing no words with any trigger ranks on description coverage. The
 * v1 catalog keeps its name-sorted output when no query is passed.
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import type { OperationContext } from '../src/core/operations.ts';
import { buildSkillCatalog } from '../src/core/skill-catalog.ts';
import { scoreSkillQuery, rankSkillQuery } from '../src/core/skill-query.ts';
import { parseSkillFrontmatter } from '../src/core/skill-frontmatter.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'skill-catalog', 'skills');

function ctx(remote: boolean, scopes?: string[]): OperationContext {
  return {
    remote,
    auth: scopes ? { token: 't', clientId: 'c', scopes } : undefined,
    config: {} as OperationContext['config'],
    engine: null as unknown as OperationContext['engine'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    sourceId: 'default',
  } as OperationContext;
}

describe('#6471: scoreSkillQuery', () => {
  const skills = [
    { key: 'a', name: 'alpha-page', description: 'find and inspect saved memory pages', triggers: ['find a page'] },
    { key: 'b', name: 'beta-sync', description: 'synchronize local repositories with the brain', triggers: ['sync my notes'] },
    { key: 'c', name: 'gamma-voice', description: 'rewrite drafts in a specific author voice', triggers: ['in their voice'], exampleQueries: ['make this email sound like my manager'] },
  ];

  test('trigger substring match wins outright', () => {
    const s = scoreSkillQuery('please find a page about garrytan', skills[0]);
    expect(s.matched?.kind).toBe('trigger');
    expect(s.score).toBeGreaterThanOrEqual(1);
  });

  test('description-only match ranks with no shared trigger words', () => {
    const s = scoreSkillQuery('how do I inspect stored memory entries', skills[0]);
    expect(s.matched?.kind).toBe('description');
    expect(s.score).toBeGreaterThan(0);
    expect(s.score).toBeLessThan(1);
  });

  test('example_queries rank between name and description', () => {
    const s = scoreSkillQuery('make this message sound like my manager wrote it', skills[2]);
    expect(s.matched?.kind).toBe('example_queries');
    expect(s.score).toBeGreaterThan(0);
  });

  test('rankSkillQuery drops zero-score entries and orders by score', () => {
    const ranked = rankSkillQuery('synchronize my repository checkout with the brain', skills);
    expect(ranked[0]?.key).toBe('b');
    expect(ranked.every(r => r.score > 0)).toBe(true);
  });
});

describe('#6471: parseSkillFrontmatter example_queries', () => {
  test('parses block and inline example_queries', () => {
    const parsed = parseSkillFrontmatter('---\nname: demo\nexample_queries:\n  - rewrite this like alice\n  - draft a post\n---\n\nbody');
    expect(parsed?.example_queries).toEqual(['rewrite this like alice', 'draft a post']);
    const inline = parseSkillFrontmatter('---\nname: demo\nexample_queries: [one query, two query]\n---\n\nbody');
    expect(inline?.example_queries).toEqual(['one query', 'two query']);
  });
});

describe('#6471: buildSkillCatalog query', () => {
  test('without query the catalog output is unchanged', () => {
    const res = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config');
    const names = res.skills.map(s => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(res.skills.every(s => s.score === undefined && s.matched === undefined)).toBe(true);
  });

  test('query ranks matching skills with score and matched line', () => {
    const res = buildSkillCatalog(ctx(true, ['read']), FIXTURE, 'config', { query: 'where is my note' });
    expect(res.skills.length).toBeGreaterThan(0);
    expect(res.skills[0].name).toBe('query-helper');
    expect(res.skills[0].score).toBeGreaterThan(0);
    expect(res.skills[0].matched).toBeTruthy();
    expect(res.count).toBe(res.skills.length);
  });
});
