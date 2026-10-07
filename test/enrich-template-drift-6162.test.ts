import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// #6162: the enrich skill's inline Person page template must not drift from
// docs/GBRAIN_RECOMMENDED_SCHEMA.md — a section the schema names high-value
// (e.g. Communication Style) silently disappeared from the skill once. Every
// `## ` section header in the schema doc's Person template must appear, in
// order, in the skill's template. The skill may carry extra sections.

const ROOT = join(import.meta.dir, '..');

/** `## ` headers inside the first ```markdown fence after `anchor`. */
function templateSections(file: string, anchor: string): string[] {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  const fence = text.indexOf('```markdown', start);
  expect(fence).toBeGreaterThanOrEqual(0);
  const close = text.indexOf('```', fence + 3);
  expect(close).toBeGreaterThan(fence);
  return text
    .slice(fence, close)
    .split('\n')
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.trim());
}

const schemaSections = templateSections(
  join(ROOT, 'docs/GBRAIN_RECOMMENDED_SCHEMA.md'), '### Person');
const skillSections = templateSections(
  join(ROOT, 'skills/enrich/SKILL.md'), '#### Person page template');

describe('#6162 enrich Person template covers the recommended schema sections', () => {
  test('every schema Person section appears in the enrich template, in order', () => {
    let cursor = 0;
    for (const wanted of schemaSections) {
      const found = skillSections.indexOf(wanted, cursor);
      expect(found, `${wanted} missing from skills/enrich/SKILL.md`).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
  });

  test('sanity: the schema template actually carries Communication Style (guard on the oracle)', () => {
    expect(schemaSections).toContain('## Communication Style');
  });
});
