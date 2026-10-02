/**
 * #5626 — `gbrain lint` validated frontmatter shape but never the page
 * `type` against the active schema pack, so `type: banana` passed clean
 * and sat invisible until the next `schema unify-types` pass. The fix
 * feeds the pack's declared vocabulary into lint as `allowedTypes` and
 * emits a stable `unknown-type` rule for an explicit frontmatter type
 * outside it.
 *
 * Locked here: the rule fires only on an EXPLICIT frontmatter type
 * (path-inferred/defaulted types are the resolver's guess, not the
 * author's declaration), is unfixable (healing is unify-types, not a
 * lint rewrite), and stays off when no vocabulary is resolvable.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintContent, runLintCore } from '../src/commands/lint.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const PACK_TYPES = new Set(['person', 'company', 'meeting', 'concept']);

const page = (type: string) => `---
title: Sample page
type: ${type}
created: 2026-01-01
slug: sample-page
---

Some ordinary body prose about a sample subject.
`;

describe('lintContent unknown-type rule', () => {
  test('explicit type outside the vocabulary → unknown-type, unfixable', () => {
    const issues = lintContent(page('banana'), '/tmp/x.md', { allowedTypes: PACK_TYPES });
    const hit = issues.find((i) => i.rule === 'unknown-type');
    expect(hit).toBeDefined();
    expect(hit!.message).toContain("'banana'");
    expect(hit!.fixable).toBe(false);
  });

  test('declared type passes clean', () => {
    const issues = lintContent(page('person'), '/tmp/x.md', { allowedTypes: PACK_TYPES });
    expect(issues.some((i) => i.rule === 'unknown-type')).toBe(false);
  });

  test('missing type reports missing-type, never unknown-type', () => {
    const content = page('person').replace(/^type: .*\n/m, '');
    const issues = lintContent(content, '/tmp/x.md', { allowedTypes: PACK_TYPES });
    expect(issues.some((i) => i.rule === 'missing-type')).toBe(true);
    expect(issues.some((i) => i.rule === 'unknown-type')).toBe(false);
  });

  test('no allowedTypes → rule off entirely', () => {
    const issues = lintContent(page('banana'), '/tmp/x.md', {});
    expect(issues.some((i) => i.rule === 'unknown-type')).toBe(false);
  });

  test('runLintCore honors an injected vocabulary end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-5626-'));
    try {
      writeFileSync(join(dir, 'bad.md'), page('banana'));
      writeFileSync(join(dir, 'good.md'), page('concept'));
      const result = await runLintCore({ target: dir, allowedTypes: PACK_TYPES });
      expect(result.total_issues).toBeGreaterThan(0);
      // The good page contributes no unknown-type finding; the bad one does.
      const seen: string[] = [];
      await runLintCore({
        target: dir,
        allowedTypes: PACK_TYPES,
        onPageIssues: (rel, issues) => {
          if (issues.some((i) => i.rule === 'unknown-type')) seen.push(rel);
        },
      });
      expect(seen).toEqual(['bad.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveLintAllowedTypes wiring (PGLite)', () => {
  let engine: PGLiteEngine;
  let dir: string;
  beforeAll(async () => {
    configureGateway({ env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    dir = mkdtempSync(join(tmpdir(), 'lint-5626-engine-'));
    writeFileSync(join(dir, 'bad.md'), page('banana'));
  });
  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
    rmSync(dir, { recursive: true, force: true });
  });

  test('live engine resolves the bundled pack vocabulary and flags drift', async () => {
    const seen: string[] = [];
    await runLintCore({
      target: dir,
      engine,
      onPageIssues: (rel, issues) => {
        if (issues.some((i) => i.rule === 'unknown-type')) seen.push(rel);
      },
    });
    expect(seen).toEqual(['bad.md']);
  });
});
