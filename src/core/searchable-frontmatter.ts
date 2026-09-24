/**
 * #5335: render a page's scalar frontmatter into `- <label>: <value>`
 * lines for the page type's declared `searchable_fields` (matched by name
 * or alias). Scalars only — arrays/objects/null and gate-owned marker
 * fields never render; values are single-lined and length-capped so a
 * crafted frontmatter blob can't smuggle block structure into a chunk.
 * Body-derived text always wins: the lines only prepend the chunk text.
 */

/** Gate-owned markers are never searchable content, even if a pack names
 * them — they carry disposition/provenance, not queryable values. */
const RESERVED_FRONTMATTER_KEYS = new Set([
  'quarantine', 'content_flag', 'embed_skip', 'atoms_scan_hash',
  'visibility', 'status', 'provenance', 'message_id', 'thread_id', 'subject',
]);

export function renderSearchableFrontmatter(
  type: string | undefined,
  frontmatter: Record<string, unknown> | null | undefined,
  activePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string>; searchable_fields?: Record<string, string> }> } | undefined,
): string | undefined {
  if (!type || !frontmatter || !activePack) return undefined;
  const decl = activePack.page_types.find(t => t.name === type || (t.aliases ?? []).includes(type));
  const fields = decl?.searchable_fields;
  if (!fields) return undefined;
  const lines: string[] = [];
  for (const [key, label] of Object.entries(fields).slice(0, 32)) {
    if (RESERVED_FRONTMATTER_KEYS.has(key)) continue;
    const raw = frontmatter[key];
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
    const value = String(raw).replace(/\s+/g, ' ').trim().slice(0, 160);
    const name = String(label).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!value || !name) continue;
    lines.push(`- ${name}: ${value}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}
