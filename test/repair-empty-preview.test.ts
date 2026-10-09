/**
 * #6351: an empty explicit-only preview printed an `--expect` hash its apply
 * could never accept — the approved set was saved only when non-empty, so the
 * apply's loadApprovedSet threw preview_changed. The preview now saves the
 * empty set too, making the printed apply a genuine no-op.
 *
 * Both preview-bound kinds had the same guard; both are covered here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

interface RepairJson { results: Array<{ affected: number; apply_command: string; applied?: number; skipped?: number }> }

describe('empty explicit-only preview approves an empty set (#6351)', () => {
  let engine: BrainEngine;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-empty-preview-'));
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    engine = pglite;
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    resetGateway();
    rmSync(home, { recursive: true, force: true });
  });

  const repair = async (kind: string, args: string[]): Promise<RepairJson> => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    try { await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, [kind, ...args, '--json'])); } finally { console.log = original; }
    return JSON.parse(lines.join('\n')) as RepairJson;
  };

  for (const kind of ['stale-atoms', 'captured-facts'] as const) {
    test(`${kind}: the apply command an empty preview prints is a no-op, not preview_changed`, async () => {
      const preview = await repair(kind, []);
      expect(preview.results[0].affected).toBe(0);
      const expectHash = preview.results[0].apply_command.match(/--expect ([0-9a-f]+)/)?.[1];
      expect(expectHash).toBeTruthy();
      // The saved empty set makes the printed apply a genuine no-op; pre-fix
      // this threw preview_changed because nothing was ever saved under hash.
      const applied = await repair(kind, ['--apply', '--expect', expectHash!]);
      expect(applied.results[0].applied ?? 0).toBe(0);
    });
  }
});
