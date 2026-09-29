import { afterAll, beforeAll, beforeEach, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { retryManagedAtomBatch } from '../src/core/persistence/atom-retry.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });

const chatResult = (text: string): ChatResult => ({ text, blocks: [], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const VALID = '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria."}]';

// #5699: on a managed brain a malformed atom batch wedges after a revision-only
// source change — the drain replays the failed checkpoint (its run key ignores
// revision) while the explicit retry refuses the shifted origin digest.
test('managed atom supersede un-wedges a revision-only source change (#5699)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-atom-supersede-'));
  const sourceId = 'atoms-supersede-5699';
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/example', { type: 'source', title: 'Example', compiled_truth: 'A private project record. '.repeat(40), frontmatter: { visibility: 'private' } }, { sourceId });
      const page = (await engine.getPage('notes/example', { sourceId }))!;
      const beforeRevision = (await engine.readPageSnapshot(page.slug, { sourceId }))!.revision;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      __setChatTransportForTests(async () => { calls++; return chatResult('Assistant: let me continue our conversation.'); });
      const first = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [],
        _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
      expect(first.status).toBe('warn');
      expect(calls).toBe(1);
      const receipt = (first.details?.write_requests as Array<{ request_id: string }>)[0];
      // Any managed write (e.g. a tag touch) moves knowledge_revision without
      // touching content_hash — the wedge needs exactly that.
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
        await tx.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=$1', [page.id]);
      }));
      const moved = (await engine.readPageSnapshot(page.slug, { sourceId }))!;
      expect(moved.revision).not.toBe(beforeRevision);
      expect(moved.page.content_hash).toBe(page.content_hash);
      // Leg 1: the ordinary drain replays the failed receipt — no new model call.
      const drain = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [],
        _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
      expect(drain.status).not.toBe('ok');
      expect(calls).toBe(1);
      // Leg 2: the documented retry refuses — the input digest moved.
      await expect(retryManagedAtomBatch(engine, sourceId, receipt.request_id, 'retry-no-supersede'))
        .rejects.toMatchObject({ code: 'source_changed' });
      expect(calls).toBe(1);
      // The supersede flag re-anchors the accepted snapshot on the current one.
      __setChatTransportForTests(async () => { calls++; return chatResult(VALID); });
      const retried = await retryManagedAtomBatch(engine, sourceId, receipt.request_id, 'retry-supersede', { supersede: true });
      expect(retried).toMatchObject({ status: 'ok', model_rerun: true });
      expect(calls).toBe(2);
      await disposePersistenceConsumer(engine);
      // The failed checkpoint advanced: the next drain converges without a model call.
      const after = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [],
        _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
      expect(after.status).toBe('ok');
      expect(calls).toBe(2);
      const [checkpoint] = await engine.executeRaw<{ completed_keys: unknown }>(
        "SELECT completed_keys FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
      expect((checkpoint.completed_keys as Array<{ failure?: string }>)[0].failure).toBeUndefined();
      // Historical receipts are kept, and the atom materialized.
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id])).toHaveLength(1);
      expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND type='atom'", [sourceId])).toHaveLength(1);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null);
    rmSync(home, { recursive: true, force: true });
  }
});

test('managed atom supersede still refuses a content change (#5699)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-atom-supersede-guard-'));
  const sourceId = 'atoms-supersede-guard-5699';
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await engine.putPage('notes/example', { type: 'source', title: 'Example', compiled_truth: 'A private project record. '.repeat(40) }, { sourceId });
      const page = (await engine.getPage('notes/example', { sourceId }))!;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let calls = 0;
      __setChatTransportForTests(async () => { calls++; return chatResult('not valid output'); });
      const first = await runPhaseExtractAtoms(engine, { sourceId, _transcripts: [],
        _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
      expect(first.status).toBe('warn');
      const receipt = (first.details?.write_requests as Array<{ request_id: string }>)[0];
      // A content change is a different batch, not a supersede.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.putPage('notes/example', { type: 'source', title: 'Example', compiled_truth: 'Different content now. '.repeat(40) }, { sourceId });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let refusal: unknown;
      try { await retryManagedAtomBatch(engine, sourceId, receipt.request_id, 'retry-supersede-content', { supersede: true }); }
      catch (error) { refusal = error; }
      expect(['source_changed', 'revision_conflict']).toContain((refusal as { code: string }).code);
      expect(calls).toBe(1);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    __setChatTransportForTests(null);
    rmSync(home, { recursive: true, force: true });
  }
});
