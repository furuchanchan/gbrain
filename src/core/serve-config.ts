/**
 * The base config `gbrain serve --http` puts on the operation context:
 * the file/env plane merged with the DB plane ONCE at startup — the same
 * merge `makeContext` applies for CLI ops. Without it, ops reached over
 * HTTP never see `gbrain config set` values (eval.capture, eval.scrub_pii,
 * ...). A DB-plane config change takes effect on serve restart.
 */
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from './config.ts';
import type { DbPlaneEngineReader } from './config-db-merge.ts';

export async function loadServeBaseConfig(
  engine: DbPlaneEngineReader,
  fallback: GBrainConfig,
): Promise<GBrainConfig> {
  const fileConfig = loadConfig() ?? fallback;
  return (await loadConfigWithEngine(engine, fileConfig)) ?? fileConfig;
}
