// #5335 — schema-pack `searchable_fields` renders declared scalar frontmatter
// into searchable chunk text (tsvector + embedding + first-chunk summary),
// without touching canonical compiled_truth or gate-owned markers.
import { test, expect, describe } from 'bun:test';
import { renderSearchableFrontmatter } from '../src/core/searchable-frontmatter.ts';
import { prepareMarkdownChunks } from '../src/core/markdown-chunks.ts';

const pack: Parameters<typeof renderSearchableFrontmatter>[2] = {
  page_types: [
    { name: 'deal', path_prefixes: [], searchable_fields: { value: 'Deal value', stage: 'Stage', probability: 'Probability (%)', ignored_obj: 'Ignored' } },
    { name: 'person', path_prefixes: [], aliases: ['contact'], searchable_fields: { role: 'Role' } },
    { name: 'note', path_prefixes: [] },
  ],
};

describe('renderSearchableFrontmatter', () => {
  test('renders labeled lines for matching scalar fields only', () => {
    const text = renderSearchableFrontmatter('deal', {
      value: 42000, stage: 'negotiation', probability: 60,
      ignored_obj: { nested: true }, other: 'not declared',
    }, pack);
    expect(text).toBe('- Deal value: 42000\n- Stage: negotiation\n- Probability (%): 60');
  });

  test('matches the page type via its declared aliases', () => {
    expect(renderSearchableFrontmatter('contact', { role: 'champion' }, pack)).toBe('- Role: champion');
  });

  test('no declaration, unknown type, or missing pack/frontmatter yields undefined', () => {
    expect(renderSearchableFrontmatter('note', { x: 1 }, pack)).toBeUndefined();
    expect(renderSearchableFrontmatter('ghost', { x: 1 }, pack)).toBeUndefined();
    expect(renderSearchableFrontmatter('deal', { value: 1 }, undefined)).toBeUndefined();
    expect(renderSearchableFrontmatter(undefined, { value: 1 }, pack)).toBeUndefined();
  });

  test('gate-owned marker fields never render even when declared', () => {
    const marked: Parameters<typeof renderSearchableFrontmatter>[2] = { page_types: [{ name: 'deal', path_prefixes: [], searchable_fields: { content_flag: 'Flag', visibility: 'Vis', value: 'Value' } }] };
    expect(renderSearchableFrontmatter('deal', { content_flag: 'x', visibility: 'private', value: 7 }, marked)).toBe('- Value: 7');
  });
});

describe('prepareMarkdownChunks frontmatter_search_text', () => {
  test('prepends the render into the first compiled_truth chunk', async () => {
    const chunks = await prepareMarkdownChunks({
      compiled_truth: 'Body prose here.', timeline: '', frontmatter: {},
      frontmatter_search_text: '- Deal value: 42000',
    });
    expect(chunks[0].chunk_source).toBe('compiled_truth');
    expect(chunks[0].chunk_text).toBe('- Deal value: 42000\n\nBody prose here.');
  });

  test('emits a sole chunk when the body is empty', async () => {
    const chunks = await prepareMarkdownChunks({
      compiled_truth: '', timeline: '', frontmatter: {},
      frontmatter_search_text: '- Role: champion',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: '- Role: champion' });
  });

  test('embed_skip / quarantine suppression still yields zero chunks', async () => {
    const chunks = await prepareMarkdownChunks({
      compiled_truth: 'Body.', timeline: '', frontmatter: { embed_skip: true },
      frontmatter_search_text: '- Deal value: 1',
    });
    expect(chunks).toEqual([]);
  });
});
