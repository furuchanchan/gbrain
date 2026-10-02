/**
 * Reserved skillpack paths — the canonical shared skillpack lives under
 * `skills/` plus `skillpack.json`, owned by the shared skill publisher
 * (put_skill / adoptSharedSkillpack), not by managed knowledge import.
 * `managedImportContent` refuses these with `skill_bundle_required`, so every
 * sync/import walker must classify them non-syncable too: a walker that hands
 * the importer a file it refuses fails the file and blocks the whole run
 * (fresh `init --content-root --git` seeds exactly these paths, so the first
 * `gbrain sync` was blocked by gbrain's own pack — #5852). The `skills`
 * segment matches at ANY depth, the same predicate the importer applies.
 */
export function isReservedSkillBundlePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return /(^|\/)skills(\/|$)/i.test(normalized) || /(^|\/)skillpack\.json$/i.test(normalized);
}
