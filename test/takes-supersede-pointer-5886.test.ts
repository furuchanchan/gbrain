/**
 * #5886: `takes_supersede` must leave the `superseded by #N` pointer in the
 * STRUCK row's source cell, matching the documented fence shape — the
 * canonical projection derives `superseded_by` only from an inactive row's
 * source, so a pointer on the new row (or nowhere) loses the chain on a
 * managed brain, and every later publication of the page re-projects NULL.
 *
 * Protects: after a takes_supersede, the struck row's fence source carries
 * `superseded by #N`, the new row keeps the caller's source, and
 * `takes.superseded_by` is set on a managed brain both at commit and after
 * a later put_page re-projection of the same page.
 * Fails when: supersedeRow stops writing the pointer on the struck row, or
 * the new row regains the self-referential `superseded by #N` source.
 * Seams: supersedeRow (fence unit), submitPageMutation + the managedBrain
 * fixture (managed projection), parseTakesFence (file truth).
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTakesFence, supersedeRow, upsertTakeRow } from '../src/core/takes-fence.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { put } from './helpers/wave-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

const BASE = `# Acme Example\n\n## Takes\n\n`;

function fenceBody(claims: string[]): string {
  let body = BASE;
  claims.forEach((claim, i) => {
    body = upsertTakeRow(body, {
      claim, kind: 'bet', holder: 'world', weight: 0.6,
      sinceDate: '2026-04-29', source: 'call notes', active: true,
    }).body;
    void i;
  });
  return body;
}

test('supersedeRow writes the pointer on the struck row and keeps the caller source on the new row', () => {
  const { body, oldRowNum, newRowNum } = supersedeRow(fenceBody(['Will reach $50B']), 1, {
    claim: 'Will reach $30B', kind: 'bet', holder: 'world', weight: 0.55,
    sinceDate: '2026-06', source: 'revised after Q2 numbers',
  });
  expect(oldRowNum).toBe(1);
  expect(newRowNum).toBe(2);
  const { takes } = parseTakesFence(body);
  const old = takes.find(t => t.rowNum === 1)!;
  const fresh = takes.find(t => t.rowNum === 2)!;
  expect(old.active).toBe(false);
  expect(old.source).toBe(`superseded by #${newRowNum}`);
  expect(fresh.source).toBe('revised after Q2 numbers');
  expect(fresh.active).toBe(true);
});

test('a supersede with no caller source leaves the new row sourceless rather than self-pointing', () => {
  const { body, newRowNum } = supersedeRow(fenceBody(['Old bet']), 1, {
    claim: 'New bet', kind: 'bet', holder: 'world', weight: 0.5,
  });
  const { takes } = parseTakesFence(body);
  const fresh = takes.find(t => t.rowNum === newRowNum)!;
  expect(fresh.source ?? '').toBe('');
  expect(fresh.source ?? '').not.toContain('superseded by');
  // And the whole fence still round-trips with exactly two rows.
  expect(takes.map(t => t.rowNum)).toEqual([1, newRowNum]);
});

for (const backend of testBackends()) {
  test(`${backend}: a managed brain keeps takes.superseded_by at commit and after re-projection`, async () => {
    await managedBrain(async ({ ctx, engine, root }) => {
      const slug = 'companies/acme-example';
      await put(ctx, slug, 'About acme-example.', 'company');
      const submit = (operation: string, params: Record<string, unknown>) =>
        submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), slug, ...params } });

      const add = await submit('takes_add', { claim: 'Will reach $50B', kind: 'bet', holder: 'world', weight: 0.7, source: 'call notes' });
      const sup = await submit('takes_supersede', { row_num: add.row_num, claim: 'Will reach $30B', weight: 0.55, source: 'revised after Q2' });
      const rows = () => engine.executeRaw<Record<string, unknown>>(
        `SELECT t.row_num, t.source, t.active, t.superseded_by FROM takes t
         JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 AND p.source_id = 'default' ORDER BY t.row_num`, [slug]);

      // The reported case: after the committed supersede the chain exists.
      expect((await rows()).map(r => [r.row_num, r.active, r.superseded_by == null ? null : Number(r.superseded_by)]))
        .toEqual([[1, false, Number(sup.new_row)], [2, true, null]]);
      // The file carries the pointer on the struck row — the projection's source of truth.
      const fileBody = readFileSync(join(root, `${slug}.md`), 'utf-8');
      const fenced = parseTakesFence(fileBody);
      expect(fenced.takes.find(t => t.rowNum === 1)?.source).toBe(`superseded by #${sup.new_row}`);
      expect(fenced.takes.find(t => t.rowNum === 2)?.source).toBe('revised after Q2');
      // A later publication of the page re-projects the fence; the pointer must survive.
      const takesSection = fileBody.slice(fileBody.indexOf('## Takes'));
      await submitPageMutation(ctx, { operation: 'put_page', params: {
        slug, request_id: randomUUID(), force: true,
        content: `---\ntype: company\ntitle: ${slug}\n---\n\nAbout acme-example. Updated prose.\n\n${takesSection}`,
      } });
      expect((await rows()).map(r => [r.row_num, r.active, r.superseded_by == null ? null : Number(r.superseded_by)]))
        .toEqual([[1, false, Number(sup.new_row)], [2, true, null]]);
    });
  });
}
