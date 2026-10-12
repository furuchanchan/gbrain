/**
 * #6490: coverage for the write-gate perf assessment on synthetic samples that
 * reproduce the recorded CI failure and the real-regression cases.
 *
 * CI run 38116492526 attempt 1 (job "test (6)") logged:
 *   round 1: gate p50 3.91 / p95 11.44; reference p50 1.48 / p95 7.46
 *   round 2: gate p50 4.73 / p95 6.86;  reference p50 1.50 / p95 4.57
 *   round 3: gate p50 4.31 / p95 8.80;  reference p50 1.37 / p95 3.54
 * The gate's wider samples captured transient stalls in >50% of iterations
 * while the narrow reference samples caught them only in their tail, so the
 * median ratio flagged a healthy gate. The p10 ratio compares clean samples
 * and stays flat; a real gate slowdown still trips it.
 */
import { describe, expect, test } from 'bun:test';
import { assessGatePerfRounds, stats, withRoundSamples, type Round } from './helpers/write-gate-perf.ts';

const LIMITS = { budgetMs: 5, ratioLimit: 5 / 1.95, quietReferenceP95Ms: 1.95, quietTolerance: 1.25 };

const round = (gate: number[], reference: number[]): Round => ({ gate: stats(gate), reference: stats(reference), samples: { gate, reference } });
/** n samples around base with small deterministic spread. */
const clean = (base: number, n: number, spread = 0.04) => Array.from({ length: n }, (_, i) => base + ((i % 7) - 3) * spread);

describe('write gate perf assessment', () => {
  test('the recorded CI failure signature is clean: medians decoupled, clean quantiles fine', () => {
    // Gate: ~55% of samples stall-hit (p50 ~4.3 like the failed run), p10 clean ~2.7.
    const gate = [...clean(2.7, 27), ...clean(4.5, 26), ...clean(9.0, 7)];
    // Reference: only its tail sees the stalls (p50 ~1.44, p95 ~5.5), p10 ~1.37.
    const reference = [...clean(1.42, 50), ...clean(4.2, 7), ...clean(7.0, 3)];
    const rounds = [round(gate, reference), round(gate.map(x => x * 1.05), reference.map(x => x * 0.98)), round(gate.map(x => x * 0.96), reference)];
    // The old statistic fails on this data — pinning the discrimination the repair makes.
    expect(Math.min(...rounds.map(r => r.gate.p50 / r.reference.p50))).toBeGreaterThan(LIMITS.ratioLimit);
    const verdict = assessGatePerfRounds(rounds, LIMITS);
    expect(verdict.violations).toEqual([]);
    expect(verdict.p10Ratio).toBeLessThan(LIMITS.ratioLimit);
  });

  test('a real gate slowdown shifts the clean quantiles and still trips the bound', () => {
    const gate = clean(6.5, 55).concat(clean(9.5, 5)); // ~2.4x the reference's clean speed
    const reference = clean(1.42, 57).concat(clean(4.0, 3));
    const verdict = assessGatePerfRounds([round(gate, reference)], LIMITS);
    expect(verdict.violations.some(v => v.startsWith('p10_ratio'))).toBe(true);
  });

  test('a gate-only slow tail still trips the p95 bound', () => {
    const gate = clean(2.7, 55).concat(clean(14, 5)); // tail-only gate inflation
    const reference = clean(1.42, 60);
    const verdict = assessGatePerfRounds([round(gate, reference)], LIMITS);
    expect(verdict.violations.some(v => v.startsWith('p95_ratio'))).toBe(true);
  });

  test('the absolute budget applies to quiet rounds only', () => {
    const quietRound = round(clean(4.2, 55).concat(clean(6.2, 5)), clean(1.42, 58).concat(clean(2.2, 2)));
    const quietVerdict = assessGatePerfRounds([quietRound], LIMITS);
    expect(quietVerdict.quietRounds).toBe(1);
    expect(quietVerdict.violations.some(v => v.startsWith('quiet gate p95'))).toBe(true);
    const loadedRound = round(clean(4.2, 55).concat(clean(6.2, 5)), clean(3.0, 58).concat(clean(4.5, 2)));
    const loadedVerdict = assessGatePerfRounds([loadedRound], LIMITS);
    expect(loadedVerdict.quietRounds).toBe(0);
    expect(loadedVerdict.minQuietGateP95Ms).toBeNull();
    expect(loadedVerdict.violations.filter(v => v.startsWith('quiet gate p95'))).toEqual([]);
  });

  test('#6430: a failed check reports every round\'s raw gate and reference samples', () => {
    const rounds = [round([3.1, 5.05], [1.9, 2.25]), round([3.2, 3.78], [2.0, 2.95])];
    let message = '';
    try { withRoundSamples(rounds, () => expect(5.05).toBeLessThan(LIMITS.budgetMs)); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('round 1 gate [3.10, 5.05]');
    expect(message).toContain('round 1 reference [1.90, 2.25]');
    expect(message).toContain('round 2 gate [3.20, 3.78]');
    expect(message).toContain('round 2 reference [2.00, 2.95]');
    let passed = true;
    try { withRoundSamples(rounds, () => expect(3.78).toBeLessThan(LIMITS.budgetMs)); } catch { passed = false; }
    expect(passed).toBe(true);
  });
});
