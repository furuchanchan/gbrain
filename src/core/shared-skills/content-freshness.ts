import { isAbsolute, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';

export interface OwnedContentFreshness {
  sourceId: string;
  pending: number;
  recovering: number;
}

export async function ownedContentFreshness(engine: BrainEngine, sourceIds?: string[]): Promise<OwnedContentFreshness[]> {
  const rows = await engine.executeRaw<{
    id: string; incarnation: string; local_path: string; config: unknown; last_commit: string | null;
    brain_id: string; receipt: string; owner_root: string; relative_path: string; pending: number; recovering: number;
  }>(`SELECT s.id,s.incarnation,s.local_path,s.config,s.last_commit,p.brain_id,c.value AS receipt,
      h.local_path AS owner_root,b.relative_path,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND r.state IN ('queued','running') AND r.recovery IS NULL)
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.kind='withdrawal-mirror' AND e.state IN ('queued','running') AND e.recovery IS NULL))::integer AS pending,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND (r.state='recovering' OR r.recovery IS NOT NULL))
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.recovery IS NOT NULL))::integer AS recovering
    FROM sources s JOIN persistence_brain p ON p.singleton=1 AND p.enabled
    JOIN config c ON c.key='shared_skills.content.v1.'||s.id||'.'||s.incarnation::text
    JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
    JOIN persistence_worktrees w ON w.id=b.worktree_id AND w.state='active' AND w.owner_host_id IS NOT NULL
    JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
    WHERE NOT s.archived AND s.local_path IS NOT NULL AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS (SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain')`, [sourceIds ?? null]);
  const result: OwnedContentFreshness[] = [];
  for (const row of rows) {
    if (sourceIds && !sourceIds.includes(row.id)) continue;
    if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config) || row.last_commit !== null) continue;
    const config = row.config as Record<string, unknown>;
    if (config.kind != null || config.remote_url != null || config.managed_clone === true || config.company_brain != null) continue;
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(row.receipt); } catch { continue; }
    if (!receipt || receipt.version !== 1 || receipt.brain_id !== row.brain_id || receipt.source_id !== row.id
      || receipt.source_incarnation !== row.incarnation || receipt.owned_root !== true || receipt.stage !== 'complete'
      || receipt.status !== 'ready' || !['content_directory', 'git'].includes(String(receipt.repository_kind)) || receipt.root !== row.local_path
      || typeof row.local_path !== 'string' || !isAbsolute(row.local_path) || typeof row.owner_root !== 'string'
      || typeof row.relative_path !== 'string' || resolve(row.owner_root, row.relative_path) !== row.local_path) continue;
    result.push({ sourceId: row.id, pending: Number(row.pending), recovering: Number(row.recovering) });
  }
  return result;
}

/**
 * Sources whose entire content is a sealed shared-skill pack adopted through
 * the canonical publisher (a `shared_skill_packs` row for the live
 * incarnation, zero pages). A dedicated pack source registered with
 * `gbrain sources add` and adopted via `apply-migrations --migration 0.53.0`
 * has no `shared_skills.content.v1` setup receipt — only `gbrain init`
 * writes one — and nothing to sync under managed persistence, so
 * `sync_freshness` staleness and `source_routing_health`'s zero-page warn
 * are false alarms for it (#6076). A pack-adopted source that DOES hold
 * pages is excluded here: its file content still needs freshness checks.
 */
export async function adoptedSkillPackOnlySourceIds(engine: BrainEngine, sourceIds?: string[]): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ id: string; pack_sealed: number }>(
    `SELECT s.id, 1 AS pack_sealed FROM sources s
       JOIN shared_skill_packs p ON p.source_id = s.id AND p.source_incarnation = s.incarnation
     WHERE NOT s.archived
       AND NOT EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = s.id)
       AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))`, [sourceIds ?? null]);
  // The literal marker column guards stub engines that answer every query
  // with their source fixture rows (the same defensive shape check
  // ownedContentFreshness applies above).
  return new Set(rows.filter(row => row.pack_sealed === 1).map(row => row.id));
}

/**
 * Sources `sync_freshness` must not judge by upstream-sync staleness:
 * writer-owned content roots (receipt-proven) plus dedicated adopted
 * skill-pack sources (#6076). Missing shared-skills tables on older brains
 * degrade each query to an empty set, exactly as the previous inline loads.
 */
export async function syncFreshnessExemptSourceIds(engine: BrainEngine): Promise<Set<string>> {
  const exempt = new Set<string>();
  try { for (const source of await ownedContentFreshness(engine)) exempt.add(source.sourceId); }
  catch (error) { if (!/does not exist|no such table/i.test(String(error))) throw error; }
  try { for (const id of await adoptedSkillPackOnlySourceIds(engine)) exempt.add(id); }
  catch (error) { if (!/does not exist|no such table/i.test(String(error))) throw error; }
  return exempt;
}
