import { describe, expect, it } from 'bun:test';

import { toCheck } from '../src/commands/doctor/checks/backup-coverage.ts';
import {
  BACKUP_STATUS_SCHEMA_VERSION,
  type BackupAssetVerdict,
  type BackupStatus,
} from '../src/core/backup/status-file.ts';

function status(assets: BackupAssetVerdict[], overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    schema_version: BACKUP_STATUS_SCHEMA_VERSION,
    checked_at: '2026-09-01T00:00:00.000Z',
    gbrain_version: '0.60.31.0',
    interval_days: 30,
    computed_by: 'doctor',
    overall: 'warn',
    totals: {
      assets: assets.length,
      no_remote: assets.filter((a) => a.state === 'no_remote').length,
      unpushed: 0,
      failing: 0,
      recoverable_repos: 0,
      pages_at_risk: 0,
    },
    assets,
    ...overrides,
  };
}

describe('#5505 backup_coverage warn message names the real failing states', () => {
  it('warn with zero no_remote assets lists the dirty/unknown assets, not an empty list', () => {
    const c = toCheck(
      status([
        { kind: 'db_only', id: 'default', state: 'info', detail: 'gbrain export' },
        { kind: 'source_repo', id: 'google-a', state: 'unknown', detail: 'not_a_git_repo' },
        { kind: 'source_repo', id: 'google-b', state: 'unknown', detail: 'not_a_git_repo' },
        { kind: 'source_repo', id: 'default', state: 'dirty', detail: 'uncommitted changes' },
      ]),
      Date.parse('2026-09-01T01:00:00.000Z'),
    );
    expect(c.status).toBe('warn');
    expect(c.message).toContain('3 of 4 knowledge asset(s) are not recoverable');
    expect(c.message).toContain('google-a (unknown)');
    expect(c.message).toContain('google-b (unknown)');
    expect(c.message).toContain('default (dirty)');
    expect(c.message).not.toContain('no git remote: .');
    expect(c.message).not.toContain('info');
  });

  it('warn with no_remote assets still names them among the failing states', () => {
    const c = toCheck(
      status([
        { kind: 'source_repo', id: 'orphan', state: 'no_remote' },
        { kind: 'source_repo', id: 'local-only', state: 'dirty' },
      ]),
      Date.parse('2026-09-01T01:00:00.000Z'),
    );
    expect(c.message).toContain('2 of 2 knowledge asset(s) are not recoverable');
    expect(c.message).toContain('orphan (no_remote)');
    expect(c.message).toContain('local-only (dirty)');
  });

  it('an ok-state repo with stale remote verification counts as unverified, not recoverable', () => {
    const c = toCheck(
      status([
        {
          kind: 'source_repo',
          id: 'repo-stale',
          state: 'ok',
          verification: { state: 'stale', checked_at: '2026-08-01T00:00:00.000Z' },
        },
      ]),
      Date.parse('2026-09-01T01:00:00.000Z'),
    );
    expect(c.message).toContain('1 of 1 knowledge asset(s) are not recoverable');
    expect(c.message).toContain('repo-stale (unverified:stale)');
  });

  it('a degraded warn with no bad assets says so rather than inventing a reason', () => {
    const c = toCheck(status([], { degraded: true }), Date.parse('2026-09-01T01:00:00.000Z'));
    expect(c.status).toBe('warn');
    expect(c.message).toContain('0 of 0 knowledge asset(s) are not recoverable: none listed');
  });

  it('overall ok still returns the unchanged green message', () => {
    const c = toCheck(
      status(
        [
          {
            kind: 'source_repo',
            id: 'repo-ok',
            state: 'ok',
            verification: { state: 'verified', checked_at: '2026-09-01T00:30:00.000Z' },
          },
        ],
        { overall: 'ok' },
      ),
      Date.parse('2026-09-01T01:00:00.000Z'),
    );
    expect(c.status).toBe('ok');
    expect(c.message).toContain('knowledge repo(s) have verified remote commits');
  });
});
