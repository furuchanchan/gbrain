/** Complete canonical version fields are optional only for legacy partial snapshots. */
export interface PageVersion {
  /** NULL/absent on legacy versions: reverting preserves current deletion state. */
  is_deleted?: boolean | null;
  /** NULL/absent on legacy versions: the snapshot's computed content date,
   * restored verbatim by revert_version so a dateless page does not inherit
   * the bad write's timestamp. */
  effective_date?: Date | null;
  effective_date_source?: string | null;
  knowledge_revision?: string | null;
  timeline?: string | null;
  title?: string | null;
  type?: string | null;
  tags?: string[] | null;
  id: number;
  page_id: number;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  snapshot_at: Date;
}
