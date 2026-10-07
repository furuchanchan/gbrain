import { describe, expect, test } from 'bun:test';
import { autoFixFrontmatter } from '../src/core/brain-writer.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

// #6157: frontmatter_integrity / lint flagged valid folded (`>-`) frontmatter
// values as NESTED_QUOTES — a continuation line like `Alex: "Why not you?", ...`
// looks like a `key: "..."` line, and the per-line quote heuristic fired on
// content inside a block scalar. The fenced block parses as YAML, so no
// line-level quote repair should ever run on it.

const fence = '---';

const reporterPage = `${fence}
type: note
title: 'Example pattern'
evidence:
  - claim: >-
      The user pushed back twice.
      Alex: "Why not you?", then "Let us keep it
      simple", and moved on.
${fence}

Body.`;

describe('#6157 folded frontmatter values are not NESTED_QUOTES', () => {
  test('validate: folded scalar with quoted continuation lines earns no findings', () => {
    const parsed = parseMarkdown(reporterPage, undefined, { validate: true });
    const codes = (parsed.errors ?? []).map(e => e.code);
    expect(codes).not.toContain('NESTED_QUOTES');
    expect(codes).not.toContain('YAML_PARSE');
    expect(parsed.frontmatter.evidence).toBeDefined();
  });

  test('validate: folded `>` (not `>-`) scalar is equally clean', () => {
    const content = `${fence}
type: note
summary: >
  Alex: "Why not you?",
  then "Let us keep it", and moved on.
${fence}

Body.`;
    const parsed = parseMarkdown(content, undefined, { validate: true });
    const codes = (parsed.errors ?? []).map(e => e.code);
    expect(codes).not.toContain('NESTED_QUOTES');
    expect(codes).not.toContain('YAML_PARSE');
  });

  test('autoFix: parseable folded block is left byte-identical', () => {
    const { content, fixes } = autoFixFrontmatter(reporterPage);
    expect(content).toBe(reporterPage);
    expect(fixes).toEqual([]);
  });

  test('autoFix: a tags-shaped continuation line inside a scalar is not normalized', () => {
    const input = `${fence}
type: note
evidence:
  - claim: >-
      The user pushed back.
      tags: ["yc", "w2025"]
${fence}

Body.`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(content).toBe(input);
    expect(fixes).toEqual([]);
  });

  test('autoFix: a top-level tags flow array on a parseable block still normalizes', () => {
    const input = `${fence}
type: person
tags: ["yc", "w2025"]
${fence}

Body.`;
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    expect(content).toContain("tags: ['yc', 'w2025']");
  });

  test('control: a genuinely nested-quoted key line is still flagged and fixed', () => {
    const input = `${fence}
type: concept
title: "Phil "Nick" Last"
${fence}

body`;
    const parsed = parseMarkdown(input, undefined, { validate: true });
    const codes = (parsed.errors ?? []).map(e => e.code);
    expect(codes).toContain('NESTED_QUOTES');
    const { content, fixes } = autoFixFrontmatter(input);
    expect(fixes.some(f => f.code === 'NESTED_QUOTES')).toBe(true);
    expect(content).toMatch(/^title: '.*'\s*$/m);
  });

  test('broken block: folded continuation lines stay unflagged while the real breakage is reported', () => {
    const input = `${fence}
type: concept
title: "Phil "Nick" Last"
evidence:
  - claim: >-
      Alex: "Why not you?", then "Let us keep it
      simple", and moved on.
${fence}

body`;
    const parsed = parseMarkdown(input, undefined, { validate: true });
    const nested = (parsed.errors ?? []).filter(e => e.code === 'NESTED_QUOTES');
    // The scalar's continuation lines are not the breakage — only the real
    // key line (title, line 3) is flagged.
    expect(nested.map(e => e.line)).toEqual([3]);
    const { content } = autoFixFrontmatter(input);
    expect(content).toContain('Alex: "Why not you?", then "Let us keep it');
  });
});
