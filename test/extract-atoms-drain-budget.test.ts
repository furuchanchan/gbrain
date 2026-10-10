/**
 * #6425 — a drain that stops only because the run's
 * `cycle.extract_atoms.budget_usd` is spent reports `stopped: 'budget'` and
 * the spend, not the misleading `no_progress` (whose "stuck backlog" reading
 * sends the operator after a resume command that cannot help).
 *
 * Regression caught: the drain adapter forwarded only `atoms_extracted` and
 * `duplicates_skipped`, so a budget-skipping batch read as {0, 0} and the
 * unchanged backlog classified `no_progress`.
 */
import { describe, expect, it } from 'bun:test';
import { runExtractAtomsDrain } from '../src/core/cycle/extract-atoms-drain.ts';

const fakeDeps = (overrides: Record<string, unknown> = {}) => ({
  withLock: async <T>(work: (signal: AbortSignal) => Promise<T>) =>
    work(new AbortController().signal),
  countRemaining: async () => 7,
  now: () => 0,
  ...overrides,
});

describe('extract-atoms drain — budget stop (#6425)', () => {
  it('a budget-only batch stops with stopped: budget and names the cap and spend', async () => {
    const result = await runExtractAtomsDrain(
      fakeDeps({
        runBatch: async () => ({
          extracted: 0,
          skipped: 0,
          budgetSkipped: 5,
          budgetUsd: 0.3,
          budgetSpentUsd: 0.31,
        }),
      }),
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('budget');
    expect(result.budget_skipped).toBe(5);
    expect(result.budget_usd).toBe(0.3);
    expect(result.budget_usd_spent).toBe(0.31);
    expect(result.status).toBe('ok');
  });

  it('a budget-skip batch that also extracted keeps draining (progress, not a stop)', async () => {
    let batch = 0;
    const result = await runExtractAtomsDrain(
      fakeDeps({
        runBatch: async () => {
          batch++;
          return batch === 1
            ? { extracted: 3, skipped: 0, budgetSkipped: 2, budgetUsd: 0.3, budgetSpentUsd: 0.3 }
            : { extracted: 0, skipped: 0, budgetSkipped: 4, budgetUsd: 0.3, budgetSpentUsd: 0 };
        },
      }),
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('budget');
    expect(result.extracted).toBe(3);
    expect(result.budget_skipped).toBe(6);
    expect(result.batches).toBe(2);
  });

  it('a zero-progress batch with no budget skips still stops with no_progress', async () => {
    const result = await runExtractAtomsDrain(
      fakeDeps({ runBatch: async () => ({ extracted: 0, skipped: 0 }) }),
      { windowMs: 1_000_000 },
    );
    expect(result.stopped).toBe('no_progress');
    expect(result.budget_skipped).toBe(0);
    expect(result.budget_usd).toBeNull();
  });
});
