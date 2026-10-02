/**
 * #5881 — gbrain-owned writes used types gbrain-base-v2 neither declares
 * nor aliases (`report` for the drift phase + `gbrain report` pages; an
 * un-typed `meeting-transcript` sidecar for meeting-ingestion), so every
 * conformance surface except `schema lint --with-db` treated them as
 * invisible-or-orphaned drift. gbrain's own outputs now store a declared
 * type: `note` (the pack's declared catch-all, kind kept on `report_type`)
 * for report pages, and the meeting-ingestion skill names `type: meeting`
 * for the transcript sidecar.
 *
 * Hermetic: in-memory PGLite, stub judge, tmpdir brain — no API keys.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseDrift } from '../src/core/cycle/drift.ts';
import { runReport } from '../src/commands/report.ts';

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'output-types-5881-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const alice = await engine.putPage('people/alice-example', {
    title: 'Alice', type: 'person', compiled_truth: 'Alice content',
  });
  await engine.addTakesBatch([
    { page_id: alice.id, row_num: 1, claim: 'CEO of Acme', kind: 'fact', holder: 'world', weight: 1.0 },
    { page_id: alice.id, row_num: 2, claim: 'Strong technical founder', kind: 'take', holder: 'garry', weight: 0.6 },
  ]);
  await engine.addTimelineEntriesBatch([
    { slug: 'people/alice-example', date: new Date().toISOString().slice(0, 10), source: 'crustdata', summary: 'Funding round closed' },
  ]);
  await engine.setConfig('dream.drift.enabled', 'true');
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('#5881 — gbrain-owned writes store pack-declared types', () => {
  test('the drift phase stamps its report page `note` (the declared catch-all), not undeclared `report`', async () => {
    const r = await runPhaseDrift(engine, {
      dryRun: false,
      auditPath: join(tmpDir, 'drift-audit.jsonl'),
      judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'x', suggested_weight: 0.3 }),
    });
    expect(r.status).toBe('complete');
    const date = new Date().toISOString().slice(0, 10);
    const page = await engine.getPage(`reports/drift-${date}`);
    expect(page).not.toBeNull();
    expect(page!.type).toBe('note');
    expect(page!.compiled_truth).toContain('DRIFTED');
  }, 60_000);

  test('`gbrain report` pages stamp `type: note` with the kind on `report_type`', async () => {
    await runReport([
      '--type', 'enrichment-sweep',
      '--title', 'Enrichment Sweep',
      '--content', 'sweep body',
      '--dir', tmpDir,
    ]);
    const dir = join(tmpDir, 'reports', 'enrichment-sweep');
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const body = readFileSync(join(dir, files[0]!), 'utf-8');
    expect(body).toContain('type: note');
    expect(body).toContain('report_type: enrichment-sweep');
    expect(body).not.toMatch(/type: report\n/);
  });

  test('meeting-ingestion names the transcript sidecar a declared type (`meeting`)', () => {
    const skill = readFileSync(
      join(import.meta.dir, '..', 'skills', 'meeting-ingestion', 'SKILL.md'),
      'utf-8',
    );
    // The sidecar instruction must name a type the default pack declares —
    // the reporter's un-typed instruction produced undeclared
    // `meeting-transcript` and mis-aliased `transcript` sidecars.
    const sidecarLine = skill.split('\n').find((l) => l.includes('-transcript'));
    expect(sidecarLine).toBeDefined();
    expect(sidecarLine!).toContain('type: meeting');
  });
});
