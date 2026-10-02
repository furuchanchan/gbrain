/**
 * #5506 — Nightly quality probe diagnosability.
 *
 * Three regressions the reporter hit on a single-provider install:
 *  1. `substituteUnavailableDefaultSlots` fell back to file-plane
 *     `getChatModel()` — a different model than the one `models.chat` /
 *     `models.tier.reasoning` actually routes chat through. The substitute
 *     must accept the caller's resolved chat route.
 *  2. Post-substitution the panel could collapse to one provider/one model
 *     and the batch summary + probe audit row still reported a plain
 *     verdict — nothing named the collapse. `panel` now records
 *     distinct providers/models + `collapsed`, and the audit row carries it.
 *  3. A failing run deleted its workDir receipt in `finally`, leaving only
 *     counts in the audit row — the run was undiagnosable. On a non-pass
 *     outcome the summary is copied into `eval-receipts` before cleanup and
 *     the audit `detail` names the receipt + failing question ids.
 *
 * Hermetic: every external effect goes through the NightlyProbeDeps DI
 * surface. No PGLite, no real LLM calls.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  runNightlyQualityProbe,
  type NightlyProbeDeps,
} from '../src/core/cycle/nightly-quality-probe.ts';
import { substituteUnavailableDefaultSlots, panelInfo } from '../src/commands/eval-cross-modal.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { readRecentQualityProbeEvents } from '../src/core/audit-quality-probe.ts';

let auditTmp: string;
let homeTmp: string;

beforeEach(() => {
  auditTmp = mkdtempSync(join(tmpdir(), 'qprobe-5506-audit-'));
  homeTmp = mkdtempSync(join(tmpdir(), 'qprobe-5506-home-'));
});

afterEach(() => {
  resetGateway();
  try { rmSync(auditTmp, { recursive: true, force: true }); } catch { /* best */ }
  try { rmSync(homeTmp, { recursive: true, force: true }); } catch { /* best */ }
});

function makeDeps(overrides: Partial<NightlyProbeDeps> = {}): NightlyProbeDeps {
  return {
    isEnabled: async () => true,
    hasEmbeddingProvider: async () => true,
    resolveMaxUsd: async () => 5,
    resolveRepoRoot: async () => process.cwd(),
    runLongMemEval: async () => { /* stub */ },
    runCrossModalBatch: async () => ({
      exitCode: 0,
      summary: {
        pass_count: 5, fail_count: 0, inconclusive_count: 0, error_count: 0,
        est_cost_usd: 0.35, verdict: 'pass',
      },
    }),
    now: () => new Date('2026-06-01T03:00:00Z'),
    ...overrides,
  };
}

async function readEvents(): Promise<Array<Record<string, unknown>>> {
  return readRecentQualityProbeEvents(7) as unknown as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 1. substituteUnavailableDefaultSlots honors a caller-supplied resolved route
// ---------------------------------------------------------------------------

describe('substituteUnavailableDefaultSlots — resolved-route substitute (#5506)', () => {
  test('substitute param wins over file-plane chat_model', () => {
    // Install like the reporter's: file chat_model says haiku, but the
    // engine-resolved chat route (models.chat / tier) is claude-cli opus-5-5
    // — a DIFFERENT model than the file-plane pin.
    configureGateway({
      chat_model: 'anthropic:claude-haiku-4-5-20251001',
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    const out = substituteUnavailableDefaultSlots(
      [
        { id: 'A', model: 'openai:gpt-5.2' },
        { id: 'B', model: 'anthropic:claude-opus-4-7' },
        { id: 'C', model: 'deepseek:deepseek-v4-pro' },
      ],
      { A: undefined, B: undefined, C: undefined },
      'anthropic:claude-sonnet-4-6', // resolved route passed through
    );
    // A + C (no openai/deepseek keys) substitute the resolved route —
    // NOT the file-plane haiku the old code would have picked.
    expect(out[0]!.model).toBe('anthropic:claude-sonnet-4-6');
    expect(out[2]!.model).toBe('anthropic:claude-sonnet-4-6');
    expect(out[1]!.model).toBe('anthropic:claude-opus-4-7');
  });

  test('unusable substitute falls back to file-plane behavior (defaults stay)', () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      env: {},
    });
    const out = substituteUnavailableDefaultSlots(
      [
        { id: 'A', model: 'openai:gpt-5.2' },
        { id: 'B', model: 'anthropic:claude-opus-4-7' },
        { id: 'C', model: 'deepseek:deepseek-v4-pro' },
      ],
      { A: undefined, B: undefined, C: undefined },
      'openai:gpt-5.2', // substitute has no usable provider either
    );
    // chat_model unusable AND substitute unusable → defaults stay.
    expect(out.map(s => s.model)).toEqual([
      'openai:gpt-5.2', 'anthropic:claude-opus-4-7', 'deepseek:deepseek-v4-pro',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. panelInfo — panel distinctness after substitution
// ---------------------------------------------------------------------------

describe('panelInfo — collapsed-panel accounting (#5506)', () => {
  test('three distinct providers → not collapsed', () => {
    const info = panelInfo([
      { id: 'A', model: 'openai:gpt-5.2' },
      { id: 'B', model: 'anthropic:claude-opus-4-7' },
      { id: 'C', model: 'deepseek:deepseek-v4-pro' },
    ]);
    expect(info.distinct_providers).toBe(3);
    expect(info.distinct_models).toBe(3);
    expect(info.collapsed).toBe(false);
    expect(info.provider_of).toEqual({ A: 'openai', B: 'anthropic', C: 'deepseek' });
  });

  test('substituted panel → 1 provider / 1 model', () => {
    const info = panelInfo([
      { id: 'A', model: 'anthropic:claude-sonnet-4-6' },
      { id: 'B', model: 'anthropic:claude-opus-4-7' },
      { id: 'C', model: 'anthropic:claude-sonnet-4-6' },
    ]);
    expect(info.distinct_providers).toBe(1);
    expect(info.distinct_models).toBe(2); // sonnet + opus are different models
    expect(info.collapsed).toBe(false);
  });

  test('fully collapsed panel (all three slots same model) → collapsed', () => {
    const info = panelInfo([
      { id: 'A', model: 'anthropic:claude-sonnet-4-6' },
      { id: 'B', model: 'anthropic:claude-sonnet-4-6' },
      { id: 'C', model: 'anthropic:claude-sonnet-4-6' },
    ]);
    expect(info.distinct_providers).toBe(1);
    expect(info.distinct_models).toBe(1);
    expect(info.collapsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Failing probe keeps the receipt + records panel/failed_qids in audit
// ---------------------------------------------------------------------------

describe('runNightlyQualityProbe — failing-run receipt retention (#5506)', () => {
  test('non-pass outcome copies the summary receipt + names it in audit detail', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp, GBRAIN_HOME: homeTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: async ({ summaryPath }) => {
          // Mimic the real adapter: write the summary to summaryPath before
          // returning (the probe copies it before the workDir rm).
          writeFileSync(summaryPath, JSON.stringify({
            verdict: 'fail', pass_count: 7, fail_count: 3,
            inconclusive_count: 0, error_count: 0, est_cost_usd: 0.42,
            panel: { distinct_providers: 1, distinct_models: 2, collapsed: false },
            per_question: [
              { question_id: 'q1', verdict: 'pass' },
              { question_id: 'q2', verdict: 'fail' },
              { question_id: 'q3', verdict: 'pass' },
              { question_id: 'q4', verdict: 'fail' },
              { question_id: 'q5', verdict: 'pass' },
            ],
          }));
          return {
            exitCode: 1,
            summary: {
              pass_count: 7, fail_count: 3, inconclusive_count: 0, error_count: 0,
              est_cost_usd: 0.42, verdict: 'fail',
              panel: { distinct_providers: 1, distinct_models: 2, collapsed: false },
              per_question: [
                { question_id: 'q1', verdict: 'pass' },
                { question_id: 'q2', verdict: 'fail' },
                { question_id: 'q3', verdict: 'pass' },
                { question_id: 'q4', verdict: 'fail' },
                { question_id: 'q5', verdict: 'pass' },
              ],
            },
          };
        },
      }));
      expect(r.outcome).toBe('fail');
      // Receipt survived the workdir cleanup.
      expect(r.detail).toContain('receipt=');
      const kept = r.detail!.match(/receipt=(\S+)/)![1]!;
      expect(existsSync(kept)).toBe(true);
      const parsed = JSON.parse(readFileSync(kept, 'utf8'));
      expect(parsed.verdict).toBe('fail');
      // Audit row names panel + failed question ids.
      const events = await readEvents();
      expect(events.length).toBe(1);
      expect(events[0]!.detail).toContain('receipt=');
      expect(events[0]!.detail).toContain('panel=2models/1providers');
      expect(events[0]!.detail).toContain('failed_qids=q2,q4');
    });
  });

  test('collapsed panel is named COLLAPSED in the audit detail', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp, GBRAIN_HOME: homeTmp }, async () => {
      await runNightlyQualityProbe(makeDeps({
        runCrossModalBatch: async () => ({
          exitCode: 0,
          summary: {
            pass_count: 5, fail_count: 0, inconclusive_count: 0, error_count: 0,
            est_cost_usd: 0.35, verdict: 'pass',
            panel: { distinct_providers: 1, distinct_models: 1, collapsed: true },
          },
        }),
      }));
      const events = await readEvents();
      expect(events.length).toBe(1);
      expect(events[0]!.detail).toContain('panel=1models/1providers COLLAPSED');
    });
  });

  test('pass outcome keeps no receipt — detail stays undefined when nothing failed', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp, GBRAIN_HOME: homeTmp }, async () => {
      const r = await runNightlyQualityProbe(makeDeps());
      expect(r.outcome).toBe('pass');
      expect(r.detail).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. resolveSubstituteModel dep is threaded into runCrossModalBatch
// ---------------------------------------------------------------------------

describe('resolveSubstituteModel threading (#5506)', () => {
  test('resolved substitute is passed to runCrossModalBatch', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp, GBRAIN_HOME: homeTmp }, async () => {
      let seen: string | undefined;
      await runNightlyQualityProbe(makeDeps({
        resolveSubstituteModel: async () => 'claude-cli:claude-opus-5-5',
        runCrossModalBatch: async (args) => {
          seen = args.substituteModel;
          return {
            exitCode: 0,
            summary: {
              pass_count: 5, fail_count: 0, inconclusive_count: 0, error_count: 0,
              est_cost_usd: 0.35, verdict: 'pass',
            },
          };
        },
      }));
      expect(seen).toBe('claude-cli:claude-opus-5-5');
    });
  });

  test('null resolveSubstituteModel omits substituteModel', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditTmp, GBRAIN_HOME: homeTmp }, async () => {
      let seen: string | undefined = 'sentinel';
      await runNightlyQualityProbe(makeDeps({
        resolveSubstituteModel: async () => null,
        runCrossModalBatch: async (args) => {
          seen = args.substituteModel;
          return {
            exitCode: 0,
            summary: {
              pass_count: 5, fail_count: 0, inconclusive_count: 0, error_count: 0,
              est_cost_usd: 0.35, verdict: 'pass',
            },
          };
        },
      }));
      expect(seen).toBeUndefined();
    });
  });
});
