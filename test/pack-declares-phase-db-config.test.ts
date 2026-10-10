/**
 * #6393 — packDeclaresPhase must resolve the active pack through the
 * engine-backed resolver, including the DB-plane tiers.
 *
 * Pre-fix it called loadActivePack({cfg, remote:false}) — config file + env
 * only — so a pack bound solely via `gbrain config set schema_pack <name>`
 * (tier 4, the brain's config table) fell through to the default pack and
 * every pack-gated phase reported `not_in_active_pack` while
 * `gbrain schema active` reported the bound pack.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { packDeclaresPhase } from '../src/core/cycle.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const HOME = mkdtempSync(join(tmpdir(), 'gbrain-6393-'));
const PACK_NAME = 'declares-xa-6393';
// The pack is bound ONLY in the brain's config table — no env var, no
// config.json field — reproducing the reporter's brain-wide DB config.
const ENV = { GBRAIN_HOME: HOME, GBRAIN_SCHEMA_PACK: undefined };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const dir = join(HOME, 'schema-packs', PACK_NAME);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, [
    'api_version: gbrain-schema-pack-v1', `name: ${PACK_NAME}`, 'version: 1.0.0', 'description: ""',
    'gbrain_min_version: 0.38.0', 'extends: null', 'borrow_from: []', 'page_types: []', 'link_types: []',
    'frontmatter_links: []', 'takes_kinds:', '  - fact', 'enrichable_types: []', 'filing_rules: []',
    'phases:', '  - extract_atoms', '',
  ].join('\n'), 'utf-8');
  __setPackLocatorForTests((name) => (name === PACK_NAME ? path : null));
}, 120_000);

afterAll(async () => {
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  await engine.disconnect();
});

beforeEach(async () => {
  _resetPackCacheForTests();
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'schema_pack%'");
});

test('a pack bound only in the DB config table still gates its declared phases (#6393)', async () => {
  await engine.setConfig('schema_pack', PACK_NAME);
  await withEnv(ENV, async () => {
    expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(true);
    expect(await packDeclaresPhase(engine, 'synthesize_concepts')).toBe(false);
  });
});

test('file-plane and env tiers still resolve through the engine loader (#6393)', async () => {
  await withEnv({ ...ENV, GBRAIN_SCHEMA_PACK: PACK_NAME }, async () => {
    expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(true);
  });
});
