/**
 * doctor/checks/backup-coverage.ts — `backup_coverage`: is the user's brain +
 * skills backed up to a git remote at all? Sibling of `bootstrap_push_health`
 * (which owns staleness of an EXISTING remote); this check owns ABSENCE.
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
  isBackupStatusStale,
  loadBackupStatus,
  type BackupStatus,
} from '../../../core/backup/status-file.ts';

/**
 * #5354 — a remote-verification negative is a definitive `fail` (a deleted or
 * unauthorized remote fails every push identically), while a verdict older
 * than the check's own staleness window can never read `ok`: "we have not
 * verified your backup in N days" is not "your backup is fine". Check has
 * no 'unknown' status — warn is the honest degradation.
 */
function staleOrMissingCheck(s: BackupStatus, details: Record<string, unknown>): Check | null {
  const remoteMissing = s.assets.filter(
    (a) => a.state === 'failing' && (a.detail?.startsWith('remote_missing') || a.detail?.startsWith('remote_branch_missing')),
  );
  if (remoteMissing.length > 0) {
    const ids = remoteMissing.map((a) => a.id).join(', ');
    return {
      name: 'backup_coverage',
      status: 'fail',
      message:
        `${remoteMissing.length} knowledge repo(s) have a remote that is deleted, unauthorized, or missing the branch — ` +
        `every git push fails the same way: ${ids}. Restore the remote or re-point origin; ` +
        '`gbrain backup status` shows the per-repo verdict.',
      details,
    };
  }
  if (s.overall === 'ok' && isBackupStatusStale(s)) {
    return {
      name: 'backup_coverage',
      status: 'warn',
      message:
        `backup verdict is ${backupCacheAge(s)} old — past its ${s.interval_days}d verification window; ` +
        'that is unverified, not git-backed. Run `gbrain backup check` to re-probe.',
      details,
    };
  }
  return null;
}

function toCheck(s: BackupStatus, note?: string): Check {
  const details = {
    totals: s.totals,
    checked_at: s.checked_at,
    computed_by: s.computed_by,
    cache_age: backupCacheAge(s),
    ...(note ? { note } : {}),
  };
  const pre = staleOrMissingCheck(s, details);
  if (pre) return pre;
  if (s.overall === 'warn') {
    // #5354: warn now grades CURRENCY too, not just absence — compose the
    // message from whichever classes fired (an unpushed-only warn must not
    // read "0 assets have no remote").
    const parts: string[] = [];
    if (s.totals.no_remote > 0) {
      const ids = s.assets.filter((a) => a.state === 'no_remote').map((a) => a.id).join(', ');
      parts.push(`${s.totals.no_remote} knowledge asset(s) have no git remote — local-only, unrecoverable on disk loss: ${ids}`);
    }
    if (s.totals.unpushed > 0) {
      const ids = s.assets.filter((a) => a.state === 'unpushed').map((a) => a.id).join(', ');
      parts.push(`${s.totals.unpushed} repo(s) have commits not on their remote: ${ids}`);
    }
    if (s.totals.failing > 0) {
      parts.push(`${s.totals.failing} repo(s) whose last push/remote check failed`);
    }
    return {
      name: 'backup_coverage',
      status: 'warn',
      message:
        `${parts.join('; ')}. ` +
        'Run `gbrain backup status` for fix commands (`gbrain bootstrap repo` / `git push` / `gbrain sources harden <id>`).',
      details,
    };
  }
  return {
    name: 'backup_coverage',
    status: 'ok',
    message: `${s.totals.recoverable_repos} knowledge repo(s) git-backed; last checked ${backupCacheAge(s)}`,
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
  if (!opts.localOnly) {
    // Remote surface: cache-only AND aggregate-only. toCheck's warn message
    // names asset ids (local paths for workspace assets) — that is local-owner
    // detail; a remote reader gets counts, never identifiers (the same
    // amendment-29 discipline as backupNoticeText's 'aggregate' surface).
    const cached = loadBackupStatus();
    if (!cached) {
      return {
        name: 'backup_coverage',
        status: 'ok',
        message: 'not checked from this surface — run `gbrain backup check` on the brain host',
      };
    }
    const details = {
      totals: cached.totals,
      checked_at: cached.checked_at,
      cache_age: backupCacheAge(cached),
      note: 'cache-only (remote surface never probes git; aggregate counts only)',
    };
    // #5354 — same honesty rules as the local surface, aggregate wording:
    // remote-verification negatives are fail; a stale ok is unverified, not
    // git-backed. Counts only, never asset ids.
    const remoteMissingCount = cached.assets.filter(
      (a) => a.state === 'failing' && (a.detail?.startsWith('remote_missing') || a.detail?.startsWith('remote_branch_missing')),
    ).length;
    if (remoteMissingCount > 0) {
      return {
        name: 'backup_coverage',
        status: 'fail',
        message:
          `${remoteMissingCount} of ${cached.totals.assets} knowledge repo(s) have a remote that is deleted, ` +
          'unauthorized, or missing the branch — every git push fails the same way. ' +
          'Run `gbrain backup status` on the brain host for the per-repo verdict.',
        details,
      };
    }
    if (cached.overall === 'ok' && isBackupStatusStale(cached)) {
      return {
        name: 'backup_coverage',
        status: 'warn',
        message:
          `backup verdict is ${backupCacheAge(cached)} old — past its ${cached.interval_days}d verification window; ` +
          'that is unverified, not git-backed. Run `gbrain backup check` on the brain host to re-probe.',
        details,
      };
    }
    return cached.overall === 'warn'
      ? {
          name: 'backup_coverage',
          status: 'warn',
          message:
            `${cached.totals.no_remote} of ${cached.totals.assets} knowledge asset(s) have no git remote — ` +
            'run `gbrain backup status` on the brain host for the per-asset detail and fix commands.',
          details,
        }
      : {
          name: 'backup_coverage',
          status: 'ok',
          message: `${cached.totals.recoverable_repos} knowledge repo(s) git-backed; last checked ${backupCacheAge(cached)}`,
          details,
        };
  }
  try {
    const s = await getBackupStatus(engine, {
      localGitProbes: true,
      computedBy: 'doctor',
      ...(opts.now ? { now: opts.now } : {}),
    });
    return toCheck(s);
  } catch {
    return { name: 'backup_coverage', status: 'warn', message: 'backup coverage unreadable' };
  }
}
