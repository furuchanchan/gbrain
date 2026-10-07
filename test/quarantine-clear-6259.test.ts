/**
 * #6259 — `quarantine clear` on a managed brain publishes through the
 * persistence coordinator instead of the legacy import path (which refuses
 * with writer_coordinator_required — the exact command doctor's advice
 * names), and the junk-pattern check distinguishes quoting a challenge
 * phrase from being the challenge page.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessContentSanity } from '../src/core/content-sanity.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runQuarantine } from '../src/commands/quarantine.ts';
import { isQuarantined } from '../src/core/quarantine.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const WALL_PHRASE = 'Enable JavaScript and cookies to continue';

describe('#6259 junk patterns: quoting is not being', () => {
  const assess = (body: string) => assessContentSanity({ compiled_truth: body, timeline: '', title: '' }).junk_pattern_matches;

  test('the phrase inside a comparison-table quotation does not flag', () => {
    const body = `## 判别点\n\n| 模式 | 结果 |\n| **无头** Chrome | ❌ 卡在挑战页（11,228 字节，只有 "${WALL_PHRASE}"）|`;
    expect(assess(body)).toEqual([]);
  });

  test('blockquote, inline code and fenced quotes do not flag either', () => {
    expect(assess(`The wall said:\n> ${WALL_PHRASE}`)).toEqual([]);
    expect(assess(`It responded \`${WALL_PHRASE}\` and nothing else.`)).toEqual([]);
    expect(assess(`Captured response:\n\`\`\`\n${WALL_PHRASE}\n\`\`\``)).toEqual([]);
    expect(assess(`墙回复了“${WALL_PHRASE}”而已`)).toEqual([]);
  });

  test('the bare phrase in body text still flags — a real wall dump', () => {
    expect(assess(`${WALL_PHRASE}\n\nSome more interstitial text.`)).toContain('enable_javascript_cookies');
    // The phrase appearing once quoted AND once bare still flags.
    const mixed = `Note: "${WALL_PHRASE}"\n\n${WALL_PHRASE}`;
    expect(assess(mixed)).toContain('enable_javascript_cookies');
  });

  test('an operator literal inside quotes is masked the same way', () => {
    const literals = [{ name: 'op_lit', substring: WALL_PHRASE }];
    const r = assessContentSanity({ compiled_truth: `quoted: "${WALL_PHRASE}"`, timeline: '', title: '', extra_literals: literals });
    expect(r.literal_substring_matches).toEqual([]);
    const r2 = assessContentSanity({ compiled_truth: WALL_PHRASE, timeline: '', title: '', extra_literals: literals });
    expect(r2.literal_substring_matches).toEqual(['op_lit']);
  });
});

describe('#6259 quarantine clear on a managed brain', () => {
  let engine: BrainEngine;
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-qclear-'));
  const root = join(dataDir, 'brain');

  beforeAll(async () => {
    mkdirSync(root);
    engine = new PGLiteEngine();
    await engine.connect({ database_path: join(dataDir, 'db') });
    await engine.initSchema();
    await resetPgliteState(engine as PGLiteEngine);
  }, 60_000);
  afterAll(async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => {});
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('clear publishes through the coordinator and drops the marker', async () => {
    const sourceId = 'qclear-src';
    await withEnv({ GBRAIN_HOME: join(dataDir, 'home') }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const slug = 'wiki/personal/reflections/wall-notes-6259';
      await submitPageMutation(ctx, { operation: 'put_page', params: {
        slug, request_id: randomUUID(),
        content: `---\nquarantine:\n  reason: junk_pattern\n  detail: enable_javascript_cookies\n  assessed_at: '2026-10-08T00:00:00Z'\ntitle: Wall notes\ntype: note\n---\nThe wall quote "${WALL_PHRASE}" is analysis, not scraped text.` } });

      expect(isQuarantined((await engine.getPage(slug, { sourceId }))?.frontmatter)).toBe(true);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        const lines: string[] = [];
        const orig = console.log;
        console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
        try {
          await runQuarantine(engine, ['clear', slug]);
        } finally { console.log = orig; }
        expect(lines.join('\n')).toContain(`Cleared "${slug}"`);
        expect(isQuarantined((await engine.getPage(slug, { sourceId }))?.frontmatter)).toBe(false);
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    });
  }, 60_000);
});
