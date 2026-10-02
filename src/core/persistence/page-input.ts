import type { OperationContext } from '../ops/contract.ts';
import { MAX_FILE_SIZE } from '../import-file.ts';
import { parseMarkdown, serializeMarkdown } from '../markdown.ts';
import { loadActivePackForWriteVocabulary } from '../schema-pack/write-vocabulary.ts';
import { classifyStoredType, sanitizeTypeForDisplay } from '../schema-pack/type-usage.ts';

/** Advisory write-result field shared with the import path's `type_warning`. */
export interface PutPageTypeWarning {
  kind: 'alias_of' | 'undeclared';
  type: string;
  canonical?: string;
  directory?: string;
}

/**
 * Classify an ordinary put_page's explicit frontmatter `type:` against the
 * write vocabulary so a stored misroute is loud at write time (the import
 * path already surfaces the same advisory). Subagent writes are normalized
 * to note + legacy_type upstream instead. Pack-unresolvable or
 * `schema.type_warnings` off → null, the write proceeds exactly as before.
 */
export async function classifyPutPageType(
  ctx: OperationContext,
  intent: Record<string, unknown>,
  sourceId: string,
): Promise<PutPageTypeWarning | null> {
  if (ctx.viaSubagent === true) return null;
  if (typeof intent.content !== 'string' || typeof intent.slug !== 'string') return null;
  let enabled = true;
  try {
    const v = await ctx.engine.getConfig('schema.type_warnings');
    enabled = !(v === 'false' || v === '0' || v === 'off');
  } catch { /* config unavailable → default on */ }
  if (!enabled) return null;
  let parsed: ReturnType<typeof parseMarkdown>;
  try { parsed = parseMarkdown(intent.content, `${intent.slug}.md`); }
  catch { return null; }
  if (parsed.typeExplicit !== true) return null;
  const pack = await loadActivePackForWriteVocabulary({ ...ctx, sourceId });
  if (!pack) return null;
  const cls = classifyStoredType(parsed.type, pack.manifest);
  if (cls.kind === 'alias_of') {
    return { kind: 'alias_of', type: parsed.type, canonical: cls.canonical, directory: cls.directory };
  }
  if (cls.kind === 'undeclared') return { kind: 'undeclared', type: parsed.type };
  return null;
}

/** Normalize model-authored types once at admission, after an existing UUID has replayed. */
export async function normalizeSubagentPageInput(ctx: OperationContext, intent: Record<string, unknown>): Promise<void> {
  if (ctx.viaSubagent !== true || !ctx.allowedSlugPrefixes?.length
    || typeof intent.content !== 'string' || typeof intent.slug !== 'string') return;
  // A rewrite must not shrink an oversized raw request below the import guard.
  if (Buffer.byteLength(intent.content, 'utf8') > MAX_FILE_SIZE) return;
  let parsed: ReturnType<typeof parseMarkdown>;
  try { parsed = parseMarkdown(intent.content, `${intent.slug}.md`); }
  catch { return; } // The importer owns the sanitized parse-error contract.
  if (parsed.typeExplicit !== true) return;
  const pack = await loadActivePackForWriteVocabulary(ctx);
  if (!pack || classifyStoredType(parsed.type, pack.manifest).kind !== 'undeclared') return;
  intent.content = serializeMarkdown({ ...parsed.frontmatter, legacy_type: parsed.type },
    parsed.compiled_truth, parsed.timeline, { type: 'note', title: parsed.title, tags: parsed.tags });
  ctx.logger.warn(`undeclared type '${sanitizeTypeForDisplay(parsed.type)}' normalized to 'note' `
    + `(legacy_type kept; pack ${pack.manifest.name})`);
}
