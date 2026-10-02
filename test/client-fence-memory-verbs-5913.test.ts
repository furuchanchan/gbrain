/**
 * #5913: prefix-bound memory verbs. `remember`, `forget` and `forget_fact`
 * each resolve a concrete target slug and run `enforceClientSlugFence` on it
 * (remember plans entitySlug ?? 'memory/unattributed'; forget/forget_fact
 * resolve the fact's page slug), but none was listed in
 * CLIENT_FENCED_WRITE_OPS — so a client with bound_slug_prefixes was denied
 * at the dispatch gate before its fence could ever run. Verified here:
 *  - the dispatch gate admits all three ops for a bound client;
 *  - a bound client remembers onto an entity under its prefix;
 *  - out-of-prefix entities and the unattributed fallback still deny
 *    (fail-closed — a bound client cannot smear 'memory/unattributed');
 *  - forget_fact is fenced by the fact's page slug, not its numeric id;
 *  - unbound clients keep the prior behavior (unattributed remember works).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName, enforceBoundClientOpAllowList, OperationError } from '../src/core/operations.ts';
import { submitRememberMutation, submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const engines: BrainEngine[] = [];
const sourceId = 'bound-memory-verbs-test';
const clientId = 'gbrain_cl_bound_memory_test';

function boundAuth(prefixes: string[] | undefined): AuthInfo {
  return {
    token: 'test-token', clientId, principal: { kind: 'oauth_client', id: clientId },
    scopes: ['read', 'write'], sourceId,
    ...(prefixes !== undefined ? { boundSlugPrefixes: prefixes } : {}),
  };
}
const ctx = (engine: BrainEngine, auth: AuthInfo): OperationContext => ({
  engine, config: { engine: engine.kind } as OperationContext['config'],
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId, auth,
});
const unboundAuth = (): AuthInfo => ({
  token: 'test-token', clientId: `${clientId}-unbound`, principal: { kind: 'oauth_client', id: `${clientId}-unbound` },
  scopes: ['read', 'write'], sourceId,
});

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
    const pg = new PostgresEngine(); await pg.connect({ database_url: process.env.DATABASE_URL, poolSize: 2 }); await pg.initSchema(); engines.push(pg);
  }
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id IN ($1,$2)', [clientId, `${clientId}-unbound`]);
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,bound_slug_prefixes)
      VALUES($1,'fixture-hash','bound-memory-test','read write',$2,ARRAY['people/'])`, [clientId, sourceId]);
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,bound_slug_prefixes)
      VALUES($1,'fixture-hash','unbound-memory-test','read write',$2,NULL)`, [`${clientId}-unbound`, sourceId]);
    await registerLocalWriter(engine, 'cli');
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Registered person.', frontmatter: {} }, { sourceId });
    await engine.putPage('other/outsider-example', { type: 'person', title: 'Outsider', compiled_truth: 'Another namespace.', frontmatter: {} }, { sourceId });
    await engine.insertFacts([{ fact: 'Foreign-namespace fact.', kind: 'fact', visibility: 'world',
      source: 'fixture', entity_slug: 'other/outsider-example', row_num: 1, source_markdown_slug: 'other/outsider-example' }], { source_id: sourceId });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id IN ($1,$2)', [clientId, `${clientId}-unbound`]);
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.disconnect();
  }
  resetGateway();
});

describe('#5913 prefix-bound remember/forget reach their slug fence', () => {
  test('the dispatch gate admits remember, forget and forget_fact for a bound client', () => {
    for (const name of ['remember', 'forget', 'forget_fact']) {
      const op = operationsByName[name];
      if (!op) throw new Error(`${name} missing`);
      expect(() => enforceBoundClientOpAllowList(boundAuth(['people/']), op)).not.toThrow();
    }
  });

  test('remember onto an entity under the bound prefix commits', async () => {
    for (const engine of engines) {
      const result = await submitRememberMutation(ctx(engine, boundAuth(['people/'])),
        { fact: 'Alice-example prefers weekly digests.', provenance: 'bound client fixture', entity: 'people/alice-example', visibility: 'world', request_id: randomUUID() });
      expect(result).toMatchObject({ state: 'committed' });
    }
  });

  test('remember onto an out-of-prefix entity denies at the resolved slug', async () => {
    for (const engine of engines) {
      try {
        await submitRememberMutation(ctx(engine, boundAuth(['people/'])),
          { fact: 'Cross-namespace claim.', provenance: 'bound client fixture', entity: 'other/outsider-example', visibility: 'world', request_id: randomUUID() });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OperationError);
        expect((e as OperationError).code).toBe('permission_denied');
        expect((e as Error).message).toContain('bound_slug_prefixes');
      }
    }
  });

  test('remember without an entity cannot smear memory/unattributed (fail-closed)', async () => {
    for (const engine of engines) {
      await expect(submitRememberMutation(ctx(engine, boundAuth(['people/'])),
        { fact: 'Unattributed claim.', provenance: 'bound client fixture', visibility: 'world', request_id: randomUUID() }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('forget_fact is fenced by the fact\'s page slug, not its numeric id', async () => {
    for (const engine of engines) {
      const bound = ctx(engine, boundAuth(['people/']));
      const inside = await submitRememberMutation(bound,
        { fact: 'Deletable in-prefix claim.', provenance: 'fixture', entity: 'people/alice-example', visibility: 'world', request_id: randomUUID() }) as { id: number | string };
      const insideId = typeof inside.id === 'string' ? inside.id : Number(inside.id);
      await expect(submitForgetMutation(bound, 'forget_fact', { id: insideId, request_id: randomUUID() }))
        .resolves.toMatchObject({ state: 'committed' });
      const [foreign] = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM facts WHERE source_id=$1 AND fact='Foreign-namespace fact.'`, [sourceId]);
      await expect(submitForgetMutation(bound, 'forget_fact', { id: foreign.id, request_id: randomUUID() }))
        .rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  test('unbound remote client keeps the prior behavior (unattributed remember commits)', async () => {
    for (const engine of engines) {
      const result = await submitRememberMutation(ctx(engine, unboundAuth()),
        { fact: 'Unbound unattributed claim.', provenance: 'unbound fixture', visibility: 'world', request_id: randomUUID() });
      expect(result).toMatchObject({ state: 'committed' });
    }
  });
});
