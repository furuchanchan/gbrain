/**
 * #5271 — pin the remote put_page replace path.
 *
 * The issue reported that MCP `put_page` "exposes no expected_revision
 * parameter", so remote callers could create but never replace. On
 * v0.51.0.0+ the op's params DO include `expected_revision` / `force` /
 * `request_id` (shared PAGE_MUTATION_PARAMS — visible to every
 * buildToolDefs consumer: stdio server, HTTP transport, serve-http
 * tools/list), and submitPageMutation carries the precondition through
 * to the coordinator. A stale tools/list cache at the client is the
 * likely explanation for the schema the reporter enumerated — clients
 * snapshot tool definitions at session start.
 *
 * These tests pin the semantics the reporter needed, through a remote
 * (untrusted) ctx — the same shape MCP dispatch produces:
 *
 *   create → readPageSnapshot → replace with expected_revision →
 *   committed; a stale expected_revision → revision_conflict;
 *   force → unconditional overwrite; replacing with NO precondition →
 *   revision_conflict (create-only without one).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { withEnv } from './helpers/with-env.ts';

const sourceId = 'remote-put-revision';
let engine: PGLiteEngine;
let root: string;
let ctx: OperationContext;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
    await engine.connect({});
    await engine.initSchema();
  });
  root = mkdtempSync(join(tmpdir(), 'gbrain-remote-put-'));
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  // Remote-shaped ctx — the same untrusted shape MCP dispatch produces.
  ctx = {
    engine,
    config: { engine: 'pglite', embedding_disabled: true },
    sourceId,
    remote: true,
    dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
  };
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

const content = (body: string) => `---\ntitle: Doc\ntype: note\n---\n${body}\n`;
const submit = (params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation: 'put_page', params: { request_id: randomUUID(), ...params } });
const revisionOf = async (slug: string) =>
  (await engine.readPageSnapshot(slug, { sourceId }))?.revision;

describe('#5271 remote put_page revision contract', () => {
  test('the advertised schema exposes expected_revision, force and request_id', () => {
    const put = operations.find((op) => op.name === 'put_page')!;
    const [def] = buildToolDefs([put]);
    const props = Object.keys(def.inputSchema.properties);
    for (const key of ['expected_revision', 'force', 'request_id', 'source_id']) {
      expect(props).toContain(key);
    }
  });

  test('remote create → read revision → replace with expected_revision commits', async () => {
    const created = await submit({ slug: 'infra/doc', content: content('v1 body') });
    expect(created.status).toBe('created_or_updated');
    const first = await revisionOf('infra/doc');
    expect(typeof first).toBe('string');

    const replaced = await submit({
      slug: 'infra/doc', content: content('v2 body'), expected_revision: first,
    });
    expect(replaced.status).toBe('created_or_updated');
    const second = await revisionOf('infra/doc');
    expect(second).not.toBe(first);
    const snap = await engine.readPageSnapshot('infra/doc', { sourceId });
    expect(snap?.page.compiled_truth).toContain('v2 body');
  });

  test('a stale expected_revision rejects with revision_conflict', async () => {
    const first = await revisionOf('infra/doc');
    const latest = await submit({
      slug: 'infra/doc', content: content('v3 body'), expected_revision: first,
    });
    expect(latest.status).toBe('created_or_updated');
    await expect(
      submit({ slug: 'infra/doc', content: content('v4 body'), expected_revision: first }),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  test('remote force overwrites without a revision', async () => {
    const forced = await submit({ slug: 'infra/doc', content: content('forced body'), force: true });
    expect(forced.status).toBe('created_or_updated');
    const snap = await engine.readPageSnapshot('infra/doc', { sourceId });
    expect(snap?.page.compiled_truth).toContain('forced body');
  });

  test('remote replace with NO precondition is refused (create-only, by design)', async () => {
    await expect(
      submit({ slug: 'infra/doc', content: content('v5 body') }),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
  });
});
