/**
 * #5928: a page stored without `subtype` (written before the pack rule applied,
 * e.g. by gbrain <= 0.60.31.0) must not refuse every later coordinated write
 * once the active pack has a matching subtype rule. The canonical file check
 * parses the on-disk file with the active pack; without subtype parity (#5521)
 * resolveParsedSubtype() adds the pack-inferred subtype to the file side only,
 * so the file "differs" from the stored snapshot and the write ends
 * source_changed.
 *
 * Harness copied from test/ingestion/put-page-write-through.test.ts; the
 * scenario is the reporter's repro in garrytan/gbrain#5928.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { operations } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withEnv } from '../helpers/with-env.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-subtype-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

afterEach(async () => {
  await disposePersistenceConsumer(engine);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  return {
    engine, config: { engine: 'pglite' as const, embedding_disabled: true }, logger,
    dryRun: false, remote: false, sourceId: 'default', ...overrides,
  };
}

const putPageOperation = operations.find((o) => o.name === 'put_page')!;
const putPage = (ctx: OperationContext, params: Record<string, unknown>) =>
  withEnv({ GBRAIN_HOME: path.join(tmpRoot, 'home') }, () => putPageOperation.handler(ctx, params));

function writePack(name: string, withSubtypeRule: boolean) {
  const packDir = path.join(tmpRoot, 'home', '.gbrain', 'schema-packs', name);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.yaml'), `api_version: gbrain-schema-pack-v1
name: ${name}
version: 1.0.0
extends: gbrain-base-v2
page_types:
  - name: meeting
    primitive: temporal
    path_prefixes: [therapy-meetings/, meetings/]
    aliases: []
    extractable: false
    expert_routing: false
${withSubtypeRule ? `    subtypes:
      - name: therapy
        when:
          path_pattern: '^therapy-meetings/'
` : ''}`);
}

describe('#5928: canonical file check vs a pack-inferred subtype the stored page lacks', () => {
  test('a page stored without subtype accepts an edit after the pack gains a matching subtype rule', async () => {
    writePack('pre-rule', false);
    writePack('post-rule', true);
    const slug = 'therapy-meetings/session';
    const content = '---\ntype: meeting\ntitle: Session\n---\n\nFirst discussion.';

    // Written while no subtype rule applies, as every page written by
    // gbrain <= 0.60.31.0 was: stored frontmatter and file carry no subtype.
    const first = await withEnv({ GBRAIN_SCHEMA_PACK: 'pre-rule' }, () =>
      putPage(makeCtx({ remote: true }), { slug, content })) as { revision: string };
    const stored = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page;
    expect(stored?.type).toBe('meeting');
    expect(stored?.frontmatter).not.toHaveProperty('subtype');
    expect(fs.readFileSync(path.join(brainDir, `${slug}.md`), 'utf8')).not.toContain('subtype:');

    // The same page is edited once the rule applies (the 0.60.32.0 upgrade).
    let outcome: unknown;
    try {
      outcome = await withEnv({ GBRAIN_SCHEMA_PACK: 'post-rule' }, () =>
        putPage(makeCtx({ remote: true }), { slug, content: content.replace('First', 'Second'), expected_revision: first.revision }));
    } catch (error) {
      outcome = { thrown: (error as { code?: string }).code, message: (error as Error).message };
    }
    expect(outcome).toMatchObject({ state: 'committed' });
    const after = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page;
    expect(after?.frontmatter.subtype).toBe('therapy');
  });

  test('control: the same edit commits when the stored page already carries the subtype', async () => {
    writePack('post-rule', true);
    const slug = 'therapy-meetings/session';
    const content = '---\ntype: meeting\ntitle: Session\n---\n\nFirst discussion.';
    const first = await withEnv({ GBRAIN_SCHEMA_PACK: 'post-rule' }, () =>
      putPage(makeCtx({ remote: true }), { slug, content })) as { revision: string };
    expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.frontmatter.subtype).toBe('therapy');
    const edited = await withEnv({ GBRAIN_SCHEMA_PACK: 'post-rule' }, () =>
      putPage(makeCtx({ remote: true }), { slug, content: content.replace('First', 'Second'), expected_revision: first.revision }));
    expect(edited).toMatchObject({ state: 'committed' });
  });

  test('guard unchanged: a real uncoordinated local edit still refuses source_changed', async () => {
    writePack('post-rule', true);
    const slug = 'therapy-meetings/session';
    const content = '---\ntype: meeting\ntitle: Session\n---\n\nFirst discussion.';
    const first = await withEnv({ GBRAIN_SCHEMA_PACK: 'post-rule' }, () =>
      putPage(makeCtx({ remote: true }), { slug, content })) as { revision: string };
    // Uncoordinated byte-level edit on the canonical file.
    fs.writeFileSync(path.join(brainDir, `${slug}.md`), content.replace('First', 'Unilateral'));
    let outcome: unknown;
    try {
      outcome = await withEnv({ GBRAIN_SCHEMA_PACK: 'post-rule' }, () =>
        putPage(makeCtx({ remote: true }), { slug, content: content.replace('First', 'Second'), expected_revision: first.revision }));
    } catch (error) {
      outcome = { thrown: (error as { code?: string }).code, message: (error as Error).message };
    }
    expect(outcome).toMatchObject({ thrown: 'source_changed' });
  });

  test('guard unchanged: a file that gained a subtype line locally still refuses', async () => {
    writePack('pre-rule', false);
    writePack('post-rule', true);
    const slug = 'therapy-meetings/session';
    const content = '---\ntype: meeting\ntitle: Session\n---\n\nFirst discussion.';
    const first = await withEnv({ GBRAIN_SCHEMA_PACK: 'pre-rule' }, () =>
      putPage(makeCtx({ remote: true }), { slug, content })) as { revision: string };
    // A local edit declaring a subtype the stored page never had.
    fs.writeFileSync(path.join(brainDir, `${slug}.md`),
      content.replace('type: meeting', 'type: meeting\nsubtype: therapy'));
    let outcome: unknown;
    try {
      outcome = await withEnv({ GBRAIN_SCHEMA_PACK: 'post-rule' }, () =>
        putPage(makeCtx({ remote: true }), { slug, content: content.replace('First', 'Second'), expected_revision: first.revision }));
    } catch (error) {
      outcome = { thrown: (error as { code?: string }).code, message: (error as Error).message };
    }
    expect(outcome).toMatchObject({ thrown: 'source_changed' });
  });
});
