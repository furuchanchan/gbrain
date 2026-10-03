import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

// #5929: a managed publication failure previously recorded only
// "Publication failed. Inspect owner diagnostics." — no cause readable from
// `gbrain write-request` because the publish ran in the owner process. The
// durable failure record now carries the original error message (and the
// constructor name when the error has no .code), sanitized and bounded.
const databaseUrl = process.env.DATABASE_URL;
for (const kind of testBackends()) {
  describe(`publication failure cause ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-publication-cause-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    const failPublish = async (engine: BrainEngine, error: unknown) => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('page');
      const row = (await claimNextWrite(engine, localHostId()))!;
      expect(row.id).toBe(admitted.id);
      const failed = await publishMutation(engine, row, {
        observedRevision: null,
        apply: async () => { throw error; },
      }, localHostId());
      return failed;
    };

    check('a causeless error keeps its message and constructor name in the durable record', async engine => {
      const failed = await failPublish(engine, new TypeError('atob is not defined in this build'));
      expect(failed.error_code).toBe('storage_error');
      expect(failed.error_message).toContain('TypeError');
      expect(failed.error_message).toContain('atob is not defined in this build');
      expect(failed.error_message).toContain('Inspect owner diagnostics.');
    });

    check('a coded error keeps its code and message', async engine => {
      const error = Object.assign(new Error('permission denied, open /private/secret.md'), { code: 'EACCES' });
      const failed = await failPublish(engine, error);
      expect(failed.error_code).toBe('storage_error');
      expect(failed.error_message).toContain('(EACCES)');
      expect(failed.error_message).toContain('permission denied, open /private/secret.md');
    });

    check('a credential-bearing cause is redacted in the durable record', async engine => {
      const failed = await failPublish(engine, new Error('connect postgres://reader:s3cret-pw@db.internal:5432/brain failed'));
      expect(failed.error_code).toBe('storage_error');
      expect(failed.error_message).not.toContain('s3cret-pw');
    });

    check('an OperationError still maps to its own code and message', async engine => {
      const failed = await failPublish(engine, new OperationError('source_changed', 'The canonical file changed during preparation.'));
      expect(failed.error_code).toBe('source_changed');
      expect(failed.error_message).toBe('The canonical file changed during preparation.');
    });
  });
}
