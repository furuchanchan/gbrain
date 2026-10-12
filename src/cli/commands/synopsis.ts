/**
 * `gbrain synopsis`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened; the record lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';

export async function run(engine: BrainEngine, args: string[]): Promise<void> {
  const { runSynopsis } = await import('../../commands/synopsis.ts');
  await runSynopsis(engine, args);
}
