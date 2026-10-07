/**
 * #6133 — placeholder-date strips inline code spans the same way it skips
 * fenced blocks: `YYYY-MM-DD` inside backticks (a sentence or a table cell)
 * documents the format; it is not an unfilled placeholder.
 */
import { test, expect, describe } from 'bun:test';
import { lintContent } from '../src/commands/lint.ts';

const SANITY_OFF = { disabled: true } as const;
const HEAD = '---\ntitle: Date docs\ntype: note\ncreated: 2026-01-05\n---\n\n';

describe('#6133 placeholder-date ignores inline code', () => {
  test('a date literal inside a single-backtick span does not fire', () => {
    const content = HEAD + '- The timeline bullet is `- **YYYY-MM-DD** | <source> — <what>`.\n\nDone.\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(0);
  });

  test('a date literal inside a table-cell backtick span does not fire', () => {
    const content = HEAD + '| field | format |\n|---|---|\n| `created` | `YYYY-MM-DD` |\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(0);
  });

  test('XX-XX and 2026-XX-XX inside backticks do not fire', () => {
    const content = HEAD + 'Use `XX-XX` or `2026-XX-XX` for partial dates.\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(0);
  });

  test('a literal inside a double-backtick span does not fire', () => {
    const content = HEAD + '`` `YYYY-MM-DD` `` is the canonical form.\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(0);
  });

  test('a placeholder in prose on the SAME line still fires', () => {
    const content = HEAD + '`YYYY-MM-DD` is the format; fill it: YYYY-MM-DD\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(1);
  });

  test('an unterminated backtick does NOT mask (conservative: still fires)', () => {
    const content = HEAD + 'format `YYYY-MM-DD\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(1);
  });

  test('a placeholder in plain prose still fires (control)', () => {
    const content = HEAD + '- 2026-XX-XX | unfilled event\n';
    const issues = lintContent(content, 'test.md', { contentSanity: SANITY_OFF });
    expect(issues.filter(i => i.rule === 'placeholder-date')).toHaveLength(1);
  });
});
