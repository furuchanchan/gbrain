import { describe, expect, test } from 'bun:test';

// #6331: `migrate --to <target>` fences the target with persistence_brain
// enabled=false until cutover. writer-ownership is structural (receipt +
// bindings), so the sync_freshness classification must not require
// p.enabled — else every managed content source on the fenced target reads
// as an unsynced upstream and blocks graduation.

const SOURCE = { id: 'default', name: '', local_path: '/owned/root/default', last_sync_at: null };

function ownedRow() {
  return {
    id: 'default', incarnation: '1', local_path: '/owned/root/default',
    config: {}, last_commit: null, brain_id: 'b1',
    receipt: JSON.stringify({
      version: 1, brain_id: 'b1', source_id: 'default', source_incarnation: '1',
      owned_root: true, stage: 'complete', status: 'ready',
      repository_kind: 'content_directory', root: '/owned/root/default',
    }),
    owner_root: '/owned/root', relative_path: 'default', pending: 0, recovering: 0,
  };
}

// owned-content SQL keys on the shared_skills receipt JOIN; its p.enabled
// clause is present only when `includeDisabled` is NOT set.
function stubEngine(): any {
  return {
    executeRaw: async (sql: string) => {
      if (sql.includes('shared_skills.content.v1')) return sql.includes('AND p.enabled') ? [] : [ownedRow()];
      if (sql.includes('FROM persistence_brain')) return [{ enabled: false }];
      return [SOURCE];
    },
  };
}

describe('#6331: sync_freshness writer-owned classification on a disabled brain', () => {
  test('ownedContentFreshness: includeDisabled returns the row, default keeps the p.enabled gate', async () => {
    const { ownedContentFreshness } = await import('../src/core/shared-skills/content-freshness.ts');
    expect(await ownedContentFreshness(stubEngine())).toEqual([]);
    const rows = await ownedContentFreshness(stubEngine(), undefined, { includeDisabled: true });
    expect(rows).toEqual([{ sourceId: 'default', pending: 0, recovering: 0 }]);
  });

  test('fenced target: managed content source is writer-owned, not never-synced', async () => {
    const { checkSyncFreshness } = await import('../src/commands/doctor.ts');
    const result = await checkSyncFreshness(stubEngine());
    expect(result.status).toBe('ok');
    expect(result.message).toContain('writer-owned');
    expect(result.message).not.toContain('never been synced');
  });
});
