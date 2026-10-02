/**
 * #5829 — Hangul word-boundary rule + `by_mention.exclude_slugs`.
 *
 * CJK text tokenizes one character per token and the matcher requires
 * strictly adjacent tokens, so a 2-syllable Hangul name matched inside any
 * longer word ("재지원" → "지원", "로그인하기" → "인하") and across a space
 * ("성장 인프라" → "장인"). Measured on a real brain: 17% of by-mention
 * links were this class of false positive.
 *
 * Two fixes, both tested here:
 *   1. Hangul-only entries get a start-boundary + literal-span rule
 *      (Hangul is word-spaced; Han/Kana keep strict-adjacency behavior).
 *   2. `by_mention.exclude_slugs` removes a slug's title AND alias entries
 *      from the gazetteer for every consumer (buildGazetteer is shared).
 *
 * Pure-fn cases build fixtures through production `tokenizeTitle` +
 * `hangulOnlyName` — same discipline as by-mention.test.ts: fixtures must
 * not re-declare the predicate they exercise.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  buildGazetteer,
  findMentionedEntities,
  hangulOnlyName,
  tokenizeTitle,
  type Gazetteer,
  type GazetteerEntry,
} from '../src/core/by-mention.ts';

function gazetteerFromTitles(entries: Array<{ slug: string; title: string; source_id?: string }>): Gazetteer {
  const g: Gazetteer = new Map();
  for (const raw of entries) {
    const tokens = tokenizeTitle(raw.title);
    if (tokens.length === 0) continue;
    const entry: GazetteerEntry = {
      slug: raw.slug,
      source_id: raw.source_id ?? 'default',
      title: raw.title,
      tokens,
      hangulName: hangulOnlyName(raw.title),
    };
    const bucket = g.get(tokens[0]!) ?? [];
    bucket.push(entry);
    g.set(tokens[0]!, bucket);
  }
  for (const bucket of g.values()) bucket.sort((a, b) => b.tokens.length - a.tokens.length);
  return g;
}

function mentions(body: string, g: Gazetteer, fromSlug = 'notes/x') {
  return findMentionedEntities(body, g, { fromSlug, fromSourceId: 'default' });
}

const JIWON = { slug: 'people/jiwon', title: '지원' };
const JANGIN = { slug: 'companies/jang-in', title: '장인' };
const INHA = { slug: 'people/inha', title: '인하' };

describe('findMentionedEntities — Hangul boundary rule (#5829)', () => {
  test('word-internal match rejected: "재지원" does not link "지원"', () => {
    const g = gazetteerFromTitles([JIWON]);
    expect(mentions('재지원 안내를 받았다', g)).toHaveLength(0);
  });

  test('cross-word adjacency rejected: "성장 인프라" does not link "장인"', () => {
    const g = gazetteerFromTitles([JANGIN]);
    expect(mentions('국가 성장 인프라로 확장한다', g)).toHaveLength(0);
  });

  test('word-internal match rejected: "로그인하기" does not link "인하"', () => {
    const g = gazetteerFromTitles([INHA]);
    expect(mentions('로그인하기 버튼을 누른다', g)).toHaveLength(0);
  });

  test('true mention kept: "지원은" links (particle attaches after a name — no end boundary)', () => {
    const g = gazetteerFromTitles([JIWON]);
    const m = mentions('어제 지원은 회의에 참석했다', g);
    expect(m).toHaveLength(1);
    expect(m[0]!.slug).toBe('people/jiwon');
  });

  test('true mention at body start kept', () => {
    const g = gazetteerFromTitles([JIWON]);
    const m = mentions('지원이 답했다', g);
    expect(m).toHaveLength(1);
  });

  test('PIN: bare-noun false positive remains — "지원을" (support) still links; the exclude list is the answer', () => {
    // The boundary rule only fixes word-internal and cross-word matches;
    // a common-noun name used as a noun ("지원을 받다" = receive support)
    // is indistinguishable without semantics — the operator exclude list
    // (tested below) is the documented answer. Pinned so the gap is explicit.
    const g = gazetteerFromTitles([JIWON]);
    const m = mentions('투자를 비롯한 지원을 받기 어렵습니다', g);
    expect(m).toHaveLength(1);
    expect(m[0]!.slug).toBe('people/jiwon');
  });

  test('PIN: connective "인하여" still links "인하" — needs the exclude list', () => {
    const g = gazetteerFromTitles([INHA]);
    const m = mentions('그 사정으로 인하여 취소되었습니다', g);
    expect(m).toHaveLength(1);
    expect(m[0]!.slug).toBe('people/inha');
  });

  test('spaced-name cost: "삼성 카드" does not link entry "삼성카드" (documented trade-off)', () => {
    const g = gazetteerFromTitles([{ slug: 'companies/samsung-card', title: '삼성카드' }]);
    expect(mentions('삼성 카드를 썼다', g)).toHaveLength(0);
  });

  test('PIN (pre-existing): a title containing a space is a dead entry — "김 지원" never matches', () => {
    // The pure-CJK title path tokenizes EVERY character (spaces included),
    // while body tokenization skips non-word non-CJK chars — so "김 지원"
    // produces ['김',' ','지','원'] tokens that no body token sequence can
    // match. Pre-existing tokenization truth, unchanged by #5829; pinned so
    // a future tokenizer change is visible.
    const g = gazetteerFromTitles([{ slug: 'people/kim-jiwon', title: '김 지원' }]);
    expect(mentions('김 지원 님께 전달', g)).toHaveLength(0);
    expect(mentions('김지원 님께 전달', g)).toHaveLength(0);
  });

  test('boundary rejection falls through to a same-bucket entry whose span matches', () => {
    // "삼성카드" (4 tokens) sorts before "삼성" (2) in the same bucket. On
    // body "삼성 카드를" the longer entry token-matches but is REJECTED by
    // the span check — the scan must continue (not break), letting "삼성"
    // match its own exact span. A real standalone mention still links.
    const g = gazetteerFromTitles([
      { slug: 'companies/samsung-card', title: '삼성카드' },
      { slug: 'companies/samsung', title: '삼성' },
    ]);
    const m = mentions('삼성 카드를 썼다', g);
    expect(m).toHaveLength(1);
    expect(m[0]!.slug).toBe('companies/samsung');
  });

  test('Han entries keep strict-adjacency behavior: "田中" matches inside "山田中人"', () => {
    const g = gazetteerFromTitles([{ slug: 'people/tanaka', title: '田中' }]);
    const m = mentions('山田中人が来た', g);
    expect(m).toHaveLength(1);
    expect(m[0]!.slug).toBe('people/tanaka');
  });

  test('Kana entries keep strict-adjacency behavior: "タロ" matches inside "タロウ"', () => {
    const g = gazetteerFromTitles([{ slug: 'people/taro', title: 'タロ' }]);
    const m = mentions('タロウが来た', g);
    expect(m).toHaveLength(1);
  });

  test('mixed Hangul+Latin name keeps strict-adjacency behavior: "지원Kim" is not Hangul-only', () => {
    const g = gazetteerFromTitles([{ slug: 'people/jiwon-kim', title: '지원Kim' }]);
    // "지원Kim은" — the char before 지 is a space; hangulOnlyName is
    // undefined so the boundary rule does not apply at all.
    const m = mentions('지원Kim은 왔다', g);
    expect(m).toHaveLength(1);
    // And a word-internal occurrence still matches (old behavior pinned).
    const m2 = mentions('재지원Kim', g);
    expect(m2).toHaveLength(1);
  });

  test('hangulOnlyName predicate: Hangul-only / spaced / mixed', () => {
    expect(hangulOnlyName('지원')).toBe('지원');
    expect(hangulOnlyName('김 지원')).toBe('김 지원');
    expect(hangulOnlyName('田中')).toBeUndefined();
    expect(hangulOnlyName('タロ')).toBeUndefined();
    expect(hangulOnlyName('지원Kim')).toBeUndefined();
    expect(hangulOnlyName('Acme')).toBeUndefined();
  });
});

describe('buildGazetteer — by_mention.exclude_slugs (#5829)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM page_aliases');
    await engine.executeRaw('DELETE FROM pages');
    await engine.unsetConfig('by_mention.exclude_slugs');
    await engine.putPage('people/jiwon', {
      type: 'person', title: '지원', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.putPage('companies/jang-in', {
      type: 'company', title: '장인', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
  });

  test('unset key is a no-op: both Hangul entities enter the gazetteer', async () => {
    const g = await buildGazetteer(engine);
    expect(g.get('지')?.some(e => e.slug === 'people/jiwon')).toBe(true);
    expect(g.get('장')?.some(e => e.slug === 'companies/jang-in')).toBe(true);
  });

  test('JSON-array form excludes the slug\'s title entry only', async () => {
    await engine.setConfig('by_mention.exclude_slugs', '["people/jiwon"]');
    const g = await buildGazetteer(engine);
    expect(g.get('지')?.some(e => e.slug === 'people/jiwon') ?? false).toBe(false);
    expect(g.get('장')?.some(e => e.slug === 'companies/jang-in')).toBe(true);
  });

  test('comma-separated form excludes multiple slugs', async () => {
    await engine.setConfig('by_mention.exclude_slugs', 'people/jiwon, companies/jang-in');
    const g = await buildGazetteer(engine);
    expect(g.get('지')?.some(e => e.slug === 'people/jiwon') ?? false).toBe(false);
    expect(g.get('장')?.some(e => e.slug === 'companies/jang-in') ?? false).toBe(false);
  });

  test('excluded slug loses its ALIAS entries too', async () => {
    await engine.putPage('people/saoirse-x', {
      type: 'person', title: 'Saoirse Example', compiled_truth: 'b', timeline: '', frontmatter: {},
    });
    await engine.setPageAliases('people/saoirse-x', 'default', ['지은']);
    await engine.setConfig('by_mention.exclude_slugs', '["people/saoirse-x"]');
    const g = await buildGazetteer(engine);
    expect(g.get('지')?.some(e => e.slug === 'people/saoirse-x') ?? false).toBe(false);
    // Title entries for other pages unaffected.
    expect(g.get('지')?.some(e => e.slug === 'people/jiwon')).toBe(true);
  });

  test('malformed value degrades to no exclusions (no crash, no silent wipe)', async () => {
    await engine.setConfig('by_mention.exclude_slugs', '["unterminated"');
    const g = await buildGazetteer(engine);
    expect(g.get('지')?.some(e => e.slug === 'people/jiwon')).toBe(true);
    expect(g.get('장')?.some(e => e.slug === 'companies/jang-in')).toBe(true);
  });
});
