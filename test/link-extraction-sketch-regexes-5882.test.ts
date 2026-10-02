/**
 * #5882 — pack sketch regexes must not override the tuned link matchers.
 *
 * The shipped base packs carry NER-only sketch regexes (added for #2117):
 * `founded` matches a bare `started`, `works_at` a bare `joined`. On the
 * markdown wikilink path those regexes ran BEFORE the in-code matchers
 * (which require `started the company` / `joined as` / `joined the team`)
 * and before the meeting attendance prior — minting `founded`/`works_at`
 * edges from meeting notes and project pages alike.
 *
 * Gates, each dead pre-fix:
 *  1. `inference.markdown_links: false` on a link_type rule removes it
 *     from markdown wikilink typing only — the rule still serves the
 *     NER/extract paths (`inferLinkTypeFromPack` is ungated).
 *  2. The real `gbrain-base-v2.yaml` marks its four sketch verbs, so a
 *     bare `started`/`joined` types `mentions`, while a production-shaped
 *     context (`founded`, `works at`) still types via the in-code
 *     matchers the fall-through reaches.
 *  3. On meeting pages an UNBOUND pack regex never pre-empts the
 *     attendance prior — only `page_type: 'meeting'`-bound rules fire.
 *  4. User packs adding genuine link verbs are unaffected: a regex rule
 *     without the flag still wins on the markdown path.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  extractPageLinks,
  type SlugResolver,
} from '../src/core/link-extraction.ts';
import {
  inferLinkTypeFromPack,
  parseSchemaPackManifest,
  parseYamlMini,
} from '../src/core/schema-pack/index.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

const BASE_V2 = parseSchemaPackManifest(
  parseYamlMini(readFileSync(
    new URL('../src/core/schema-pack/base/gbrain-base-v2.yaml', import.meta.url).pathname, 'utf-8')),
  { path: 'gbrain-base-v2.yaml' },
);

const SKETCH_PACK = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1',
  name: 'sketch-5882',
  version: '0.1.0',
  extends: null,
  page_types: [],
  link_types: [
    { name: 'founded', inference: { regex: '\\b(founded|started)\\b', markdown_links: false } },
    { name: 'works_at', inference: { regex: '\\b(works at|joined)\\b', markdown_links: false } },
    { name: 'parent_of', inference: { regex: '\\bparent of\\b' } },
  ],
  frontmatter_links: [],
});

const links = async (slug: string, content: string, pageType: string, pack: unknown,
  targetType?: (s: string) => string | undefined) =>
  (await extractPageLinks(slug, content, {}, pageType as never, nullResolver,
    { skipFrontmatter: true, pack: pack as never, targetType })).candidates;

describe('#5882 — markdown_links:false keeps NER sketches off the wikilink path', () => {
  test('gbrain-base-v2 marks its four sketch verbs NER-only', () => {
    const flagged = BASE_V2.link_types
      .filter(lt => lt.inference?.markdown_links === false)
      .map(lt => lt.name)
      .sort();
    expect(flagged).toEqual(['advises', 'founded', 'invested_in', 'works_at']);
  });

  test('bare started/joined no longer mint founded/works_at (real base-v2)', async () => {
    const got = await links('projects/acme',
      'The rebuild started [Widget Co](companies/widget-co) as a side effort, and Dana joined [Widget Co](companies/widget-co) later.',
      'project', BASE_V2);
    expect(got.every(c => c.linkType === 'mentions')).toBe(true);
  });

  test('production-shaped contexts still type through the pack fall-through', async () => {
    // Separate link contexts — FOUNDED_RE/WORKS_AT_RE inspect a ~240-char
    // window, so one sentence can't isolate them.
    const founded = await links('people/dana', 'Dana founded [Acme](companies/acme).', 'person', BASE_V2);
    expect(founded[0]?.linkType).toBe('founded');
    const works = await links('people/dana', 'Dana works at [Widget Co](companies/widget-co).', 'person', BASE_V2);
    expect(works[0]?.linkType).toBe('works_at');
  });

  test('flagged rules still serve NER paths — inferLinkTypeFromPack is ungated', () => {
    // The flag is a markdown-path contract; the shared resolver stays
    // identical for extract-ner / extract evidence inference (#2117 use).
    expect(inferLinkTypeFromPack(SKETCH_PACK, 'person', 'she started Acme in 2021')).toBe('founded');
    expect(inferLinkTypeFromPack(BASE_V2, 'person', 'joined widget-co in June')).toBe('works_at');
  });

  test('unflagged user-pack regex still wins on markdown (no #3190 regression)', async () => {
    const got = await links('companies/acme',
      'Acme is the parent of [Sub Co](companies/sub-co).', 'company', SKETCH_PACK);
    expect(got[0]?.linkType).toBe('parent_of');
  });
});

describe('#5882 — pack regexes never pre-empt the meeting attendance prior', () => {
  const targetType = (s: string) => s.startsWith('people/') ? 'person' : 'company';
  // The Attendees section must close on a heading — a trailing prose
  // line inside the section invalidates the whole evidence range.
  const MEETING = '## Attendees\n- [Alice](people/alice)\n- [Bob](people/bob)\n\n## Notes\n\nBob joined [Carol](people/carol) for the roadmap sync.';
  // `joined` matches the sketch works_at regex; [[Carol]] sits OUTSIDE the
  // attendance ranges, so the prior yields mentions — never works_at.
  test('unbound pack regex is inert on meeting pages (unflagged pack)', async () => {
    const UNBOUND = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'unbound-5882',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [
        { name: 'works_at', inference: { regex: '\\bjoined\\b' } },
      ],
      frontmatter_links: [],
    });
    const got = await links('meetings/2026-09-01-roadmap', MEETING, 'meeting', UNBOUND, targetType);
    expect(got.find(c => c.targetSlug === 'people/carol')?.linkType).toBe('mentions');
    expect(got.some(c => c.linkType === 'works_at')).toBe(false);
  });

  test('attendance evidence still mints attended on meeting pages', async () => {
    const got = await links('meetings/2026-09-01-roadmap', MEETING, 'meeting', SKETCH_PACK, targetType);
    expect(got.find(c => c.targetSlug === 'people/alice')?.linkType).toBe('attended');
    expect(got.find(c => c.targetSlug === 'people/carol')?.linkType).toBe('mentions');
  });

  test('a page_type:meeting-bound pack rule may still fire on meetings', async () => {
    const BOUND = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'bound-5882',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [
        { name: 'discussed_in', inference: { page_type: 'meeting', regex: '\\bsync\\b' } },
      ],
      frontmatter_links: [],
    });
    const got = await links('meetings/2026-09-01-roadmap', MEETING, 'meeting', BOUND, targetType);
    expect(got.find(c => c.targetSlug === 'people/carol')?.linkType).toBe('discussed_in');
  });
});
