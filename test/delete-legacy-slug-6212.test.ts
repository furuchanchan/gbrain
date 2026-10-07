/**
 * #6212 — a legacy row whose slug no longer matches the current grammar
 * (e.g. `people/jane doe`, written by an older version) must still be
 * deletable: validate on create, not on delete. put_page and restore_page
 * keep the grammar check (they create files); delete only removes.
 *
 * PGLite in-memory ($0); the delete goes through the real coordinated write
 * path (dispatchToolCall → submitPageMutation).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let fixture: string;
let cliRegistration: LocalRegistration;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  fixture = mkdtempSync(join(tmpdir(), 'gb-6212-'));
  mkdirSync(join(fixture, 'brain'));
  await engine.setConfig('sync.repo_path', join(fixture, 'brain'));
});
afterEach(async () => { await disposePersistenceConsumer(engine); rmSync(fixture, { recursive: true, force: true }); });

function test(name: string, run: () => Promise<void>, timeout = 30_000) {
  bunTest(name, () => withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
    cliRegistration = await registerLocalWriter(engine, 'cli');
    try { await run(); } finally { await disposePersistenceConsumer(engine); }
  }), timeout);
}

async function call(name: string, params: Record<string, unknown>) {
  const response = await withVerifiedLocalRegistration(engine, cliRegistration, () => dispatchToolCall(engine, name, params, {
    remote: false, config: { engine: 'pglite' }, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} },
  }));
  const text = (response.content[0] as { text: string }).text;
  return { isError: response.isError === true, body: JSON.parse(text), text };
}

/** Seed a page under a valid slug, then rewrite its slug to the legacy space form. */
async function seedLegacySlug(validSlug: string, legacySlug: string) {
  const put = await call('put_page', {
    slug: validSlug,
    content: `---\ntitle: Legacy\n---\n\nBody.\n`,
    request_id: randomUUID(),
  });
  expect(put.isError).toBe(false);
  await engine.executeRaw(`UPDATE pages SET slug = $1 WHERE slug = $2`, [legacySlug, validSlug]);
}

describe('#6212 delete of a legacy space-containing slug', () => {
  test('delete_page accepts an existing row whose slug violates the current grammar', async () => {
    await seedLegacySlug('people/jane-doe', 'people/jane doe');
    const before = await engine.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE slug = 'people/jane doe'`);
    expect(before).toHaveLength(1);

    const rev = (await engine.executeRaw<{ knowledge_revision: string }>(
      `SELECT knowledge_revision FROM pages WHERE slug = 'people/jane doe'`, []))[0].knowledge_revision;
    const del = await call('delete_page', {
      slug: 'people/jane doe', expected_revision: rev, request_id: randomUUID(),
    });
    expect({ isError: del.isError, body: del.body }).toMatchObject({ isError: false });

    const after = await engine.executeRaw<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM pages WHERE slug = 'people/jane doe'`, []);
    expect(after[0].deleted_at).not.toBeNull();
  });

  test('a dry-run delete of a legacy slug reports the action instead of invalid_params', async () => {
    await seedLegacySlug('people/jane-doe', 'people/jane doe');
    const dry = await call('delete_page', { slug: 'people/jane doe', dry_run: true });
    expect(dry.body).toMatchObject({ dry_run: true, action: 'delete_page', slug: 'people/jane doe' });
  });

  test('purge of a legacy slug removes the row entirely', async () => {
    await seedLegacySlug('people/jane-doe', 'people/jane doe');
    const rev = (await engine.executeRaw<{ knowledge_revision: string }>(
      `SELECT knowledge_revision FROM pages WHERE slug = 'people/jane doe'`, []))[0].knowledge_revision;
    const purged = await call('delete_page', { slug: 'people/jane doe', purge: true, expected_revision: rev, request_id: randomUUID() });
    expect(purged.isError).toBe(false);
    const rows = await engine.executeRaw(`SELECT 1 FROM pages WHERE slug = 'people/jane doe'`, []);
    expect(rows).toHaveLength(0);
  });

  test('create-side validation is unchanged: put_page still rejects a space slug', async () => {
    const put = await call('put_page', {
      slug: 'people/jane doe',
      content: `---\ntitle: Nope\n---\n\nBody.\n`,
      request_id: randomUUID(),
    });
    expect(put.isError).toBe(true);
    expect(put.body).toMatchObject({ error: 'invalid_params' });
  });
});
