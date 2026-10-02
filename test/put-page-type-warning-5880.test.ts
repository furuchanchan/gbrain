// #5880 — ordinary put_page stores any explicit `type:` as-is; the write
// result now carries the same alias/undeclared `type_warning` advisory the
// import path reports (gated by `schema.type_warnings`, default on).
// Subagent writes keep the note+legacy_type normalization path instead.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let root: string;
let fixtureDir: string;
let registration: LocalRegistration;
let schemaVersion: string;
const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };
const content = (type: string) => `---\ntitle: Example\ntype: ${type}\ntags: [t]\n---\n\nBody ${type}`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  resetGateway();
  _resetWriteThroughCacheForTest();
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
  fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-put-warning-5880-'));
  root = join(fixtureDir, 'brain');
  mkdirSync(root);
  await engine.setConfig('sync.repo_path', root);
});

afterEach(async () => {
  await disposePersistenceConsumer(engine);
  resetGateway();
  _resetWriteThroughCacheForTest();
  rmSync(fixtureDir, { recursive: true, force: true });
});

function test(name: string, run: () => Promise<void>, timeout = 20_000) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
    registration = await registerLocalWriter(engine, 'stdio', {
      sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'],
    });
    try { await run(); } finally { await disposePersistenceConsumer(engine); }
  }), timeout);
}

async function dispatch(name: string, params: Record<string, unknown>, sourceId = 'default') {
  const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params, {
    remote: true, config: { engine: 'pglite' }, sourceId, auth: { ...auth, sourceId },
    logger: { info() {}, warn() {}, error() {} },
  }));
  return { response, payload: JSON.parse((response.content[0] as { text: string }).text) };
}

async function seedTestPack(): Promise<void> {
  const dir = join(fixtureDir, 'testpack');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, `api_version: gbrain-schema-pack-v1
name: testpack
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: note
    primitive: entity
    path_prefixes:
      - notes/
    aliases:
      - memo
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds:
  - fact
enrichable_types: []
filing_rules: []
`, 'utf-8');
  __setPackLocatorForTests((n) => (n === 'testpack' ? path : null));
  await engine.setConfig('schema_pack', 'testpack');
}

describe('put_page type_warning advisory (#5880)', () => {
  test('undeclared explicit type commits but returns type_warning', async () => {
    await seedTestPack();
    const { payload } = await dispatch('put_page', {
      slug: 'notes/idea-page', content: content('idea'), request_id: randomUUID(),
    });
    const warning = payload.type_warning as { kind: string; type: string };
    expect(warning).toBeDefined();
    expect(warning.kind).toBe('undeclared');
    expect(warning.type).toBe('idea');
    // The type still stores literally — advisory only.
    const page = await engine.getPage('notes/idea-page', { sourceId: 'default' });
    expect(page?.type).toBe('idea');
  });

  test('alias explicit type warns with the canonical type', async () => {
    await seedTestPack();
    const { payload } = await dispatch('put_page', {
      slug: 'notes/memo-page', content: content('memo'), request_id: randomUUID(),
    });
    const warning = payload.type_warning as { kind: string; type: string; canonical: string };
    expect(warning.kind).toBe('alias_of');
    expect(warning.canonical).toBe('note');
  });

  test('declared type returns no type_warning', async () => {
    await seedTestPack();
    const { payload } = await dispatch('put_page', {
      slug: 'notes/note-page', content: content('note'), request_id: randomUUID(),
    });
    expect(payload.type_warning).toBeUndefined();
  });

  test('schema.type_warnings=false silences the advisory', async () => {
    await seedTestPack();
    await engine.setConfig('schema.type_warnings', 'false');
    const { payload } = await dispatch('put_page', {
      slug: 'notes/quiet-page', content: content('idea'), request_id: randomUUID(),
    });
    expect(payload.type_warning).toBeUndefined();
    const page = await engine.getPage('notes/quiet-page', { sourceId: 'default' });
    expect(page?.type).toBe('idea');
  });
});
