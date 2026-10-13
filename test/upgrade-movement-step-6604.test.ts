/**
 * #6604 regression: `gbrain upgrade` printed its final next-step line via a
 * post-swap `await import('./sources-writer-movement.ts')`. That import pulls
 * the whole command graph — after an in-place source swap, a NEW module can
 * demand named exports absent from a stale-cached OLD module loaded pre-swap,
 * so the parent exited 1 (`Export named 'isMultimodalEnabled' not found`)
 * AFTER the install and migrations had already succeeded.
 *
 * The fix: MOVEMENT_SUPERVISOR_STEP lives in the zero-dependency
 * src/commands/movement-step.ts, statically imported by upgrade.ts (loaded
 * before the swap), and re-exported from sources-writer-movement.ts so its
 * public surface is unchanged.
 *
 * Pinned here: upgrade.ts never dynamically imports the movement command
 * graph, both print sites use the static constant, movement-step.ts has no
 * module imports of its own, and the re-export keeps the value identical.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOVEMENT_SUPERVISOR_STEP } from '../src/commands/movement-step.ts';
import { MOVEMENT_SUPERVISOR_STEP as REEXPORTED } from '../src/commands/sources-writer-movement.ts';

const UPGRADE_SRC = readFileSync(join(import.meta.dir, '../src/commands/upgrade.ts'), 'utf-8');
const STEP_SRC = readFileSync(join(import.meta.dir, '../src/commands/movement-step.ts'), 'utf-8');

describe('upgrade post-swap next-step import (#6604)', () => {
  test('upgrade.ts statically imports the step constant, never the command graph', () => {
    expect(UPGRADE_SRC).toContain("from './movement-step.ts'");
    expect(UPGRADE_SRC).not.toContain("import('./sources-writer-movement.ts')");
    expect(UPGRADE_SRC).not.toContain('import("./sources-writer-movement.ts")');
  });

  test('both final next-step sites print the static constant', () => {
    expect(UPGRADE_SRC).toContain('`Next: ${MOVEMENT_SUPERVISOR_STEP}`');
    // upgrade tail + post-upgrade tail
    const uses = UPGRADE_SRC.split('${MOVEMENT_SUPERVISOR_STEP}').length - 1;
    expect(uses).toBe(2);
  });

  test('movement-step.ts is dependency-free (safe to load pre-swap)', () => {
    const depLines = STEP_SRC.split('\n').filter(
      (l) => /^\s*(import|export\s+\*|export\s*\{[^}]*\}\s*from)\b/.test(l),
    );
    expect(depLines).toEqual([]);
  });

  test('sources-writer-movement.ts re-export keeps the public surface identical', () => {
    expect(REEXPORTED).toBe(MOVEMENT_SUPERVISOR_STEP);
    expect(REEXPORTED).toBe('after restarting serve and the workers, run: gbrain sources writer movement');
  });
});
