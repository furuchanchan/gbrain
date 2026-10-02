/**
 * doctor/checks/backup-coverage.ts — `backup_coverage` diagnostics.
 *
 * Trust boundary (D4): git probes against DB-supplied local_path run only on
 * the trusted local doctor path (`localOnly: true`, the checkSyncFreshness
 * precedent at doctor.ts). Without it the check is a cache-only reader.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { getBackupStatus } from '../../../core/backup/coverage.ts';
import {
  backupCacheAge,
  backupCheckDisabled,
  loadBackupStatus,
  currentBackupEvidence,
  type BackupStatus,
} from '../../../core/backup/status-file.ts';

// #5505: warn can come from ANY non-recoverable state — no_remote, unpushed,
// dirty, failing, unknown, or a verified-looking repo whose remote check is
// stale/unavailable (`repos.length > recoverable`). Naming only `no_remote`
// assets printed "0 asset(s) have no git remote: <empty>" in exactly the
// common case the warn exists for.
function warnAssets(s: BackupStatus): Array<{ id: string; state: string }> {
  const repoKind = (k: string) => k === 'source_repo' || k === 'bootstrap_workspace';
  return s.assets
    .filter((a) =>
      (a.state !== 'ok' && a.state !== 'info') ||
      (repoKind(a.kind) && a.state === 'ok' && a.verification?.state !== 'verified'))
    .map((a) => ({
      id: a.id,
      state: a.state === 'ok' ? `unverified:${a.verification?.state ?? 'none'}` : a.state,
    }));
}

export function toCheck(s: BackupStatus, now?: number): Check {
  const details = {
    totals: s.totals,
    checked_at: s.checked_at,
    computed_by: s.computed_by,
    cache_age: backupCacheAge(s, now),
    recovery_scope: s.recovery_scope,
    degraded: s.degraded === true,
  };
  if (s.overall === 'warn') {
    const bad = warnAssets(s);
    const list = bad.length
      ? bad.map((a) => `${a.id} (${a.state})`).join(', ')
      : 'none listed';
    return {
      name: 'backup_coverage',
      status: 'warn',
      message:
        `${bad.length} of ${s.totals.assets} knowledge asset(s) are not recoverable: ${list}. Current recovery is not verified for all repositories. ` +
        'Run `gbrain backup status` for fix commands (`gbrain bootstrap repo` / `git remote add origin <url>` / `gbrain sources harden <id>`).',
      details,
    };
  }
  return {
    name: 'backup_coverage',
    status: 'ok',
    message: `${s.totals.recoverable_repos} knowledge repo(s) have verified remote commits; last checked ${backupCacheAge(s, now)}. Git does not cover the full database.`,
    details,
  };
}

export async function checkBackupCoverage(
  engine: BrainEngine,
  opts: { localOnly?: boolean; now?: Date } = {},
): Promise<Check> {
  if (backupCheckDisabled()) {
    return {
      name: 'backup_coverage',
      status: 'ok',
      message: 'backup check disabled (backup.check_enabled=false or GBRAIN_BACKUP_CHECK=0)',
    };
  }
  if (opts.localOnly !== true) {
    // Remote surface: cache-only AND aggregate-only. toCheck's warn message
    // names asset ids (local paths for workspace assets) — that is local-owner
    // detail; a remote reader gets counts, never identifiers (the same
    // amendment-29 discipline as backupNoticeText's 'aggregate' surface).
    const raw = loadBackupStatus();
    if (!raw) {
      return {
        name: 'backup_coverage',
        status: 'warn',
        message: 'not checked from this surface — run `gbrain backup check` on the brain host',
      };
    }
    const cached = currentBackupEvidence(raw, opts.now?.getTime());
    const details = {
      totals: cached.totals,
      checked_at: cached.checked_at,
      cache_age: backupCacheAge(cached, opts.now?.getTime()),
      recovery_scope: cached.recovery_scope,
      degraded: cached.degraded === true,
      note: 'cache-only (remote surface never probes git; aggregate counts only)',
    };
    return cached.overall === 'warn'
      ? {
          name: 'backup_coverage',
          status: 'warn',
          message:
            `${warnAssets(cached).length} of ${cached.totals.assets} knowledge asset(s) are not recoverable; current recovery is not verified for all repositories — ` +
            'run `gbrain backup status` on the brain host for the per-asset detail and fix commands.',
          details,
        }
      : {
          name: 'backup_coverage',
          status: 'ok',
          message: `${cached.totals.recoverable_repos} knowledge repo(s) have verified remote commits in the cache; last checked ${backupCacheAge(cached, opts.now?.getTime())}. Git does not cover the full database.`,
          details,
        };
  }
  try {
    const s = await getBackupStatus(engine, {
      localGitProbes: true,
      verifyRemoteRefs: true,
      computedBy: 'doctor',
      ...(opts.now ? { now: opts.now } : {}),
    });
    return toCheck(s, opts.now?.getTime());
  } catch {
    return { name: 'backup_coverage', status: 'warn', message: 'backup coverage unreadable' };
  }
}
