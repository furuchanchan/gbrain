/**
 * #6466: `shared_skills.migration.enabled=false` (file plane) declines the
 * v0.53.0 shared-skills host migration. Pins:
 *   - declinedMigrationVersions reads the opt-out engine-free;
 *   - buildPlan buckets the version as `declined` whatever the ledger says
 *     (an applied reconcile stops re-checking; a wedged one stops reporting);
 *   - `apply-migrations --migration 0.53.0` refuses naming the setting;
 *   - migrationLedgerSummary reports `declined`, never pending/partial/wedged;
 *   - `config set`/`unset` writes and removes the nested file-plane key.
 */

import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __testing, applyMigrations } from '../src/commands/apply-migrations.ts';
import {
  declinedMigrationVersions,
  migrationLedgerSummary,
} from '../src/core/migration-ledger.ts';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

const { buildPlan, indexCompleted } = __testing;
const noEngine = null as unknown as BrainEngine;

const DECLINE_CFG: GBrainConfig = {
  engine: 'pglite',
  shared_skills: { migration: { enabled: false } },
};

function entry(version: string, status: CompletedMigrationEntry['status']): CompletedMigrationEntry {
  return { ts: '2026-09-01T00:00:00Z', version, status } as CompletedMigrationEntry;
}

/** Write a config.json (and optionally a ledger) under a fresh GBRAIN_HOME parent. */
function homeWithConfig(cfg: GBrainConfig, ledger?: CompletedMigrationEntry[]): string {
  const parent = mkdtempSync(join(tmpdir(), 'gb-decline-'));
  mkdirSync(join(parent, '.gbrain', 'migrations'), { recursive: true });
  writeFileSync(join(parent, '.gbrain', 'config.json'), JSON.stringify(cfg));
  if (ledger) writeFileSync(join(parent, '.gbrain', 'migrations', 'completed.jsonl'), ledger.map(e => JSON.stringify(e)).join('\n') + '\n');
  return parent;
}

describe('declinedMigrationVersions (#6466)', () => {
  test('enabled=false declines 0.53.0; absent/true/yes does not', () => {
    expect(declinedMigrationVersions(DECLINE_CFG).has('0.53.0')).toBe(true);
    expect(declinedMigrationVersions({ engine: 'pglite', shared_skills: { migration: { enabled: 'false' } } } as GBrainConfig).has('0.53.0')).toBe(true);
    expect(declinedMigrationVersions({ engine: 'pglite' } as GBrainConfig).has('0.53.0')).toBe(false);
    expect(declinedMigrationVersions({ engine: 'pglite', shared_skills: { migration: { enabled: true } } } as GBrainConfig).has('0.53.0')).toBe(false);
    expect(declinedMigrationVersions(null).has('0.53.0')).toBe(false);
  });
});

describe('buildPlan declined bucket (#6466)', () => {
  const declined = new Set(['0.53.0']);

  test('pending → declined; applied+reconcile → declined; wedged → declined', () => {
    const pending = buildPlan(indexCompleted([]), '99.0.0', undefined, declined);
    expect(pending.declined.map(m => m.version)).toEqual(['0.53.0']);
    expect(pending.pending.map(m => m.version)).not.toContain('0.53.0');

    const applied = buildPlan(indexCompleted([entry('0.53.0', 'complete')]), '99.0.0', undefined, declined);
    expect(applied.declined.map(m => m.version)).toEqual(['0.53.0']);
    expect(applied.applied.map(m => m.version)).not.toContain('0.53.0');

    const wedged = buildPlan(indexCompleted([entry('0.53.0', 'partial'), entry('0.53.0', 'partial'), entry('0.53.0', 'partial')]), '99.0.0', undefined, declined);
    expect(wedged.declined.map(m => m.version)).toEqual(['0.53.0']);
    expect(wedged.wedged.length).toBe(0);
  });

  test('--migration filter keeps the declined row visible', () => {
    const plan = buildPlan(indexCompleted([]), '99.0.0', '0.53.0', declined);
    expect(plan.declined.map(m => m.version)).toEqual(['0.53.0']);
  });
});

describe('apply-migrations --migration refusal (#6466)', () => {
  test('an explicit --migration 0.53.0 refuses, naming shared_skills.migration.enabled', async () => {
    const parent = homeWithConfig(DECLINE_CFG);
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const orig = console.error;
      let err = '';
      console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
      try {
        const res = await applyMigrations(['--migration', '0.53.0']);
        expect(res.exitCode).toBe(2);
        expect(res.failure?.message ?? '').toContain('shared_skills.migration.enabled');
      } finally {
        console.error = orig;
      }
      expect(err).toContain('shared_skills.migration.enabled');
    });
  });
});

describe('migrationLedgerSummary declined bucket (#6466)', () => {
  test('declined version lands in `declined`, not pending/partial/wedged', async () => {
    const parent = homeWithConfig(DECLINE_CFG, [entry('0.53.0', 'partial')]);
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      const summary = migrationLedgerSummary('99.0.0');
      expect(summary.declined).toEqual(['0.53.0']);
      expect(summary.partial).not.toContain('0.53.0');
      expect(summary.pending).not.toContain('0.53.0');
      expect(summary.wedged).not.toContain('0.53.0');
    });
  });
});

describe('config set/unset shared_skills.migration.enabled (#6466)', () => {
  test('set false → file plane nested write; unset removes the leaf', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-cfg-decline-'));
    const orig = console.log;
    console.log = () => {};
    try {
      await withEnv({ GBRAIN_HOME: parent }, async () => {
        await runConfig(noEngine, ['set', 'shared_skills.migration.enabled', 'false']);
        const cfgPath = join(parent, '.gbrain', 'config.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { shared_skills?: { migration?: { enabled?: boolean } } };
        expect(cfg.shared_skills?.migration?.enabled).toBe(false);
        expect(declinedMigrationVersions().has('0.53.0')).toBe(true);

        await runConfig(noEngine, ['unset', 'shared_skills.migration.enabled']);
        const cfg2 = JSON.parse(readFileSync(cfgPath, 'utf8')) as { shared_skills?: { migration?: { enabled?: boolean } } };
        expect(cfg2.shared_skills?.migration?.enabled).toBeUndefined();
        expect(declinedMigrationVersions().has('0.53.0')).toBe(false);
      });
    } finally {
      console.log = orig;
    }
  });
});
