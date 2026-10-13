/**
 * #6589 regression: `gbrain serve --http` (both the OAuth path in
 * src/commands/serve-http.ts and the bearer path in src/mcp/http-transport.ts)
 * built the operation-context config from the FILE plane only, so ops over
 * HTTP never saw DB-plane `gbrain config set` values — eval.capture and
 * eval.scrub_pii silently never enabled over HTTP. The fix merges the DB
 * plane once at startup via loadServeBaseConfig (same merge makeContext
 * applies for CLI ops); a DB-plane change takes effect on serve restart.
 *
 * Pinned here: DB-plane eval.capture/eval.scrub_pii flow into the serve base
 * config (both directions of the bool), and the caller's engine fallback is
 * preserved when no file config exists.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { loadServeBaseConfig } from '../src/core/serve-config.ts';
import { isEvalCaptureEnabled, isEvalScrubEnabled } from '../src/core/eval-capture.ts';
import {
  _resetDbPlaneMergeMemoForTests,
  type DbPlaneEngineReader,
} from '../src/core/config-db-merge.ts';
import type { GBrainConfig } from '../src/core/config.ts';

function stubEngine(map: Record<string, string>): DbPlaneEngineReader {
  return {
    async getConfig(key: string) {
      return map[key];
    },
    async listConfigKeys(prefix: string) {
      return Object.keys(map).filter((k) => k.startsWith(prefix));
    },
  };
}

beforeEach(() => _resetDbPlaneMergeMemoForTests());

describe('loadServeBaseConfig (#6589)', () => {
  test('DB-plane eval.capture=true enables capture over the serve ctx config', async () => {
    const cfg = await loadServeBaseConfig(stubEngine({ 'eval.capture': 'true' }), { engine: 'pglite' } as GBrainConfig);
    expect(cfg.eval?.capture).toBe(true);
    expect(isEvalCaptureEnabled(cfg)).toBe(true);
  });

  test('DB-plane eval.capture=false is a real off, not unset', async () => {
    const cfg = await loadServeBaseConfig(stubEngine({ 'eval.capture': 'false' }), { engine: 'pglite' } as GBrainConfig);
    expect(cfg.eval?.capture).toBe(false);
    expect(isEvalCaptureEnabled(cfg)).toBe(false);
  });

  test('DB-plane eval.scrub_pii=false reaches the scrub gate', async () => {
    const cfg = await loadServeBaseConfig(stubEngine({ 'eval.capture': 'true', 'eval.scrub_pii': 'false' }), { engine: 'pglite' } as GBrainConfig);
    expect(isEvalScrubEnabled(cfg)).toBe(false);
  });

  test('caller fallback is preserved when no file config exists', async () => {
    const cfg = await loadServeBaseConfig(stubEngine({}), { engine: 'pglite' } as GBrainConfig);
    expect(cfg.engine).toBe('pglite');
    expect(isEvalScrubEnabled(cfg)).toBe(true); // scrub default stays on
  });
});
