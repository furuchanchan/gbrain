/**
 * issue #6257 — empty-section ignored fenced code blocks: any `## Heading`
 * inside a ``` or ~~~ fence was treated as a real page section, so a page
 * documenting an output template reported N false "Empty section" findings.
 * The rule now tracks fences the same way placeholder-date (#3958) does.
 */

import { test, expect, describe } from 'bun:test';
import { lintContent } from '../src/commands/lint.ts';

const SANITY_OFF = { disabled: true } as const;
const FM = '---\ntitle: Demo\ntype: note\ncreated: 2026-01-05\n---\n\n';
const emptySections = (content: string) =>
  lintContent(content, 'test.md', { contentSanity: SANITY_OFF }).filter(i => i.rule === 'empty-section');

describe('#6257 empty-section skips fenced code blocks', () => {
  test('## headings inside a ``` fence are not sections', () => {
    const content = FM +
      '# Demo\n\nThe output format looks like this:\n\n' +
      '```markdown\n## One-line overview\n## Decisions\n## Action items\n```\n\nEnd of page.\n';
    expect(emptySections(content)).toHaveLength(0);
  });

  test('## headings inside a ~~~ fence are not sections', () => {
    const content = FM +
      '# Demo\n\n~~~\n## Quoted\n~~~\n\nDone.\n';
    expect(emptySections(content)).toHaveLength(0);
  });

  test('a genuinely empty real section is still reported', () => {
    const content = FM +
      '# Demo\n\n## Decisions\n\n## Action items\n\nbody\n';
    const found = emptySections(content);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Decisions');
    expect(found[0].line).toBe(content.split('\n').findIndex(l => l === '## Decisions') + 1);
  });

  test('a fenced ## inside a real section body does not split it', () => {
    const content = FM +
      '# Demo\n\n## Decisions\n\n```\n## Nested template\n```\n\n## Next\n\nbody\n';
    expect(emptySections(content)).toHaveLength(0);
  });
});
