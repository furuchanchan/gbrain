// #5476 — bundled SKILL.md frontmatter must satisfy skillMetadata's marker
// contract (publication/privacy keys take string 'true/false/yes/no' only).
// `capture` shipped `writes_pages: ["inbox/*"]` and `schema-author`
// `writes_pages: []`; a single unparseable bundled skill aborts the
// one-mutation adoptSharedSkillpack for the whole pack.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSkillFiles, skillMetadata } from '../src/core/shared-skills/manifest.ts';

const skillsRoot = join(import.meta.dir, '..', 'skills');
const bundled = readdirSync(skillsRoot, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)
  .filter(name => {
    try { readFileSync(join(skillsRoot, name, 'SKILL.md')); return true; } catch { return false; }
  })
  .sort();

describe('#5476 bundled skills parse under skillMetadata', () => {
  test('every bundled SKILL.md yields valid metadata (no approval_required)', () => {
    expect(bundled.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const name of bundled) {
      const files = normalizeSkillFiles(name, [
        {
          path: `skills/${name}/SKILL.md`,
          content: readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8'),
          file_class: 'prose',
          audience: ['readers'],
        },
      ]);
      try {
        skillMetadata(name, files, {});
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('capture declares writes_pages: true with the inbox glob moved to writes_to', () => {
    const files = normalizeSkillFiles('capture', [
      {
        path: 'skills/capture/SKILL.md',
        content: readFileSync(join(skillsRoot, 'capture', 'SKILL.md'), 'utf8'),
        file_class: 'prose',
        audience: ['readers'],
      },
    ]);
    const md = skillMetadata('capture', files, {});
    expect(md.writes_pages).toBe(true);
    const body = readFileSync(join(skillsRoot, 'capture', 'SKILL.md'), 'utf8');
    expect(body).toContain('writes_to:\n  - "inbox/"');
  });

  test('schema-author declares writes_pages: false (mutates pack/page.type, files no pages)', () => {
    const files = normalizeSkillFiles('schema-author', [
      {
        path: 'skills/schema-author/SKILL.md',
        content: readFileSync(join(skillsRoot, 'schema-author', 'SKILL.md'), 'utf8'),
        file_class: 'prose',
        audience: ['readers'],
      },
    ]);
    expect(skillMetadata('schema-author', files, {}).writes_pages).toBe(false);
  });
});
