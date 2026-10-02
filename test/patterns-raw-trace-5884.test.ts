/**
 * #5884 — dream patterns pages failed doctor raw_provenance forever:
 * #5733 stamped them `dream_generated` (putting them under the #1978
 * invariant) but the stamp step never recorded a raw trace, and a
 * manual stamp didn't survive the next patterns run's subagent put_page.
 * The stamp itself now also applies `raw_trace_exempt` + reason — the
 * pattern page's raw material is the in-brain reflection corpus, not a
 * single source document — on BOTH the unmanaged stamp lane and the
 * managed maintenance-write lane, so every rerun restores it.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { rawProvenanceCheck } from '../src/commands/doctor/checks/core-health.ts';
import { __testing } from '../src/core/cycle/patterns.ts';
import { randomUUID } from 'node:crypto';

const { stampPatternOutputs } = __testing;

let engine: PGLiteEngine;

const page = (title: string) => ({
  type: 'note' as const,
  title,
  compiled_truth: `${title} body.`,
  timeline: '',
  frontmatter: {},
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('stampPatternOutputs — raw_trace_exempt (#5884)', () => {
  test('unmanaged lane: stamp adds the exemption and raw_provenance reads ok', async () => {
    const slug = 'wiki/personal/patterns/focus';
    await engine.putPage(slug, page('Focus'));
    await stampPatternOutputs(engine, null, [{ slug, source_id: 'default' }], '2026-10-02');
    const p = await engine.getPage(slug, { sourceId: 'default' });
    expect(p?.frontmatter?.dream_generated).toBe(true);
    expect(p?.frontmatter?.raw_trace_exempt).toBe(true);
    expect(String(p?.frontmatter?.raw_trace_exempt_reason)).toContain('reflection');
    const check = await rawProvenanceCheck(engine);
    expect(check.status).toBe('ok');
  });

  test('a put_page rewrite that drops the marker is re-stamped on the next run', async () => {
    const slug = 'wiki/personal/patterns/renewal';
    await engine.putPage(slug, page('Renewal'));
    await stampPatternOutputs(engine, null, [{ slug, source_id: 'default' }], '2026-10-02');
    // The next patterns run replaces the page via a fresh put_page — the
    // exemption is wiped with the rest of the frontmatter...
    const fresh = page('Renewal v2');
    await engine.putPage(slug, fresh);
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.frontmatter?.raw_trace_exempt).toBeUndefined();
    // ...and the stamp step restores it (the pre-fix gap the issue reported).
    await stampPatternOutputs(engine, null, [{ slug, source_id: 'default' }], '2026-10-03');
    const p = await engine.getPage(slug, { sourceId: 'default' });
    expect(p?.frontmatter?.raw_trace_exempt).toBe(true);
    const check = await rawProvenanceCheck(engine);
    expect(check.status).toBe('ok');
  });

  test('managed lane: the maintenance write carries the same exemption', async () => {
    await managedBrain(async ({ engine: mg, ctx, root }) => {
      const slug = 'wiki/personal/patterns/managed';
      await submitPageMutation(ctx, { operation: 'put_page', params: {
        request_id: randomUUID(), slug,
        content: `---\ntype: note\ntitle: Managed Pattern\n---\n\nbody.\n`,
      } });
      const authority = await maintenancePreflight(mg, 'default', root);
      expect(authority).not.toBeNull();
      await stampPatternOutputs(mg, authority, [{ slug, source_id: 'default' }], '2026-10-02');
      const p = await mg.getPage(slug, { sourceId: 'default' });
      expect(p?.frontmatter?.raw_trace_exempt).toBe(true);
      expect(String(p?.frontmatter?.raw_trace_exempt_reason)).toContain('reflection');
      const check = await rawProvenanceCheck(mg);
      expect(check.status).toBe('ok');
    });
  });
});
