/**
 * #6356: `gbrain bootstrap verify` ran its put_page roundtrip with the
 * waitForWrite 5 s agent default, so a slow remote Postgres commit that
 * lands a few seconds later failed verify. The roundtrip ctx must carry
 * the same write wait the CLI uses (--wait / GBRAIN_WRITE_WAIT_MS /
 * persistence.write_wait_ms / 30 s default).
 */
import { describe, expect, test } from 'bun:test';
import { localCtx } from '../src/core/bootstrap/verify.ts';
import { CLI_WRITE_WAIT_MS } from '../src/core/persistence/write-wait.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const engine = { kind: 'pglite' } as unknown as BrainEngine;

describe('bootstrap verify roundtrip write wait (#6356)', () => {
  test('defaults to the CLI write wait (30 s), not the 5 s agent default', () =>
    withEnv({ GBRAIN_WRITE_WAIT_MS: undefined }, () => {
      const ctx = localCtx(engine, 'verify-src');
      expect(ctx.writeWaitMs).toBe(CLI_WRITE_WAIT_MS);
      expect(ctx.writeWaitMs).toBeGreaterThan(5_000);
    }));

  test('honors GBRAIN_WRITE_WAIT_MS like a CLI write', () =>
    withEnv({ GBRAIN_WRITE_WAIT_MS: '60000' }, () => {
      expect(localCtx(engine, 'verify-src').writeWaitMs).toBe(60_000);
    }));
});
