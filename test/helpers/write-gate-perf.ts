/**
 * Statistics and round assessment shared by test/write-gate-perf.slow.test.ts
 * and its unit coverage (test/write-gate-perf-stats.test.ts).
 *
 * #6490: the two workloads' distributions have different shapes — the gate's
 * samples are ~2x wider than the reference's, so an intermittent CPU stall
 * lands inside far more gate samples than reference samples. On CI run
 * 38116492526 attempt 1 that decoupled the medians: the gate p50 rose to
 * 3.9-4.7 ms while the reference p50 held at 1.4-1.5 ms (the stalls were
 * visible only in its p95, 3.5-7.5 ms), and the p50 ratio tripped the limit
 * without any gate regression. Medians of differently-shaped distributions
 * are not a stable cost signal under load. The p10 ratio compares the two
 * workloads on their clean samples: a real gate slowdown shifts the whole
 * distribution (p10 included), while transient load leaves the fastest decile
 * untouched unless ~all samples stall — at which point the reference's p10
 * inflates too and the ratio still cancels.
 */

export type Stats = { p10: number; p50: number; p95: number; max: number };
export type Round = { gate: Stats; reference: Stats; samples: { gate: number[]; reference: number[] } };

export const stats = (times: number[]): Stats => {
  const sorted = [...times].sort((x, y) => x - y);
  return {
    p10: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.1) - 1)]!,
    p50: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    max: sorted[sorted.length - 1]!,
  };
};

export type GatePerfLimits = {
  budgetMs: number;
  ratioLimit: number;
  quietReferenceP95Ms: number;
  quietTolerance: number;
};

export type GatePerfAssessment = {
  /** Min over rounds of gate.p10 / reference.p10 — the clean-sample cost ratio. */
  p10Ratio: number;
  /** Min over rounds of gate.p95 / reference.p95 — the contended-tail cost ratio. */
  p95Ratio: number;
  /** Rounds whose reference ran at quiet speed; the absolute budget applies to these. */
  quietRounds: number;
  minQuietGateP95Ms: number | null;
  violations: string[];
};

export function assessGatePerfRounds(rounds: Round[], limits: GatePerfLimits): GatePerfAssessment {
  const ratio = (pick: (s: Stats) => number) => Math.min(...rounds.map(r => pick(r.gate) / pick(r.reference)));
  const p10Ratio = ratio(s => s.p10);
  const p95Ratio = ratio(s => s.p95);
  const violations: string[] = [];
  if (p10Ratio > limits.ratioLimit) violations.push(`p10_ratio ${p10Ratio.toFixed(2)} > ${limits.ratioLimit.toFixed(2)}`);
  if (p95Ratio > limits.ratioLimit) violations.push(`p95_ratio ${p95Ratio.toFixed(2)} > ${limits.ratioLimit.toFixed(2)}`);
  const quiet = rounds.filter(r => r.reference.p95 <= limits.quietReferenceP95Ms * limits.quietTolerance);
  const minQuietGateP95Ms = quiet.length ? Math.min(...quiet.map(r => r.gate.p95)) : null;
  if (minQuietGateP95Ms !== null && minQuietGateP95Ms >= limits.budgetMs) {
    violations.push(`quiet gate p95 ${minQuietGateP95Ms.toFixed(2)} ms >= ${limits.budgetMs} ms budget`);
  }
  return { p10Ratio, p95Ratio, quietRounds: quiet.length, minQuietGateP95Ms, violations };
}

/** One console line per round; p50 stays printed for forensics even though it is no longer an asserted statistic. */
export function formatRound(index: number, r: Round): string {
  return `[write-gate perf] 300 KB typical round ${index}: `
    + `gate p10 ${r.gate.p10.toFixed(2)} / p50 ${r.gate.p50.toFixed(2)} / p95 ${r.gate.p95.toFixed(2)} ms; `
    + `reference p10 ${r.reference.p10.toFixed(2)} / p50 ${r.reference.p50.toFixed(2)} / p95 ${r.reference.p95.toFixed(2)} ms; `
    + `ratio p10 ${(r.gate.p10 / r.reference.p10).toFixed(2)} / p50 ${(r.gate.p50 / r.reference.p50).toFixed(2)} / p95 ${(r.gate.p95 / r.reference.p95).toFixed(2)}`;
}

/** #6430: a failed check carries every round's raw samples, so the next occurrence shows where the slow samples fell. */
export function withRoundSamples(rounds: Round[], check: () => void): void {
  try { check(); } catch (error) {
    const raw = rounds.map((r, i) => `round ${i + 1} gate [${r.samples.gate.map(x => x.toFixed(2)).join(', ')}]\n`
      + `round ${i + 1} reference [${r.samples.reference.map(x => x.toFixed(2)).join(', ')}]`).join('\n');
    if (error instanceof Error) error.message += `\n[write-gate perf] raw samples (ms, in measurement order):\n${raw}`;
    throw error;
  }
}
