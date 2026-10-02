/**
 * Orphans operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `orphansOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam, readPolicyOpts } from './context.ts';
import { ALL_SOURCES } from '../source-id.ts';

// --- Orphans ---

const find_orphans: Operation = {
  name: 'find_orphans',
  description: 'Find disconnected pages. Default mode "islanded" (no live inbound AND no outbound link) matches get_health.orphan_pages; mode "inbound" is the legacy no-inbound-only view. Essential for content enrichment cycles.',
  params: {
    include_pseudo: {
      type: 'boolean',
      description: 'Include auto-generated and pseudo pages (default: false)',
    },
    mode: {
      type: 'string',
      description: "#4524: orphan definition — 'islanded' (default; agrees with get_health.orphan_pages and doctor) or 'inbound' (legacy: no inbound links, even when the page links out).",
    },
    source_id: {
      type: 'string',
      description: 'Optional concrete source id — narrows the caller’s authorized scope like the CLI’s --source. A denied, missing, or archived source fails rather than widening.',
    },
    limit: {
      type: 'number',
      description: 'Max orphan rows returned per call (default 200, max 1000). total_orphans still reports the full filtered count.',
    },
    offset: {
      type: 'number',
      description: 'Row offset into the filtered orphan list for paging (default 0).',
    },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const { findOrphans } = await import('../../commands/orphans.ts');
    // #4524: validate rather than silently coerce — an unknown mode must not
    // quietly fall back to the default and misreport the orphan set.
    const mode = p.mode === undefined ? undefined : (p.mode as string);
    if (mode !== undefined && mode !== 'inbound' && mode !== 'islanded') {
      throw new Error(`find_orphans: invalid mode "${mode}" — use 'inbound' or 'islanded'`);
    }
    // v0.41.29.0 (Codex F8): scope by the caller's source (ctx.sourceId /
    // ctx.auth.allowedSources) via the canonical sourceScopeOpts ladder.
    // Pre-fix, find_orphans returned brain-wide orphans regardless of a
    // source-bound OAuth client's scope — a read leak in the v0.34.1
    // source-isolation class. Local CLI callers route through `gbrain
    // orphans --source` instead (ctx.remote === false → empty scope here).
    // #4398-class explicit-source handling: an explicit source_id narrows
    // the caller's grant via the single trust+grant resolver (out-of-grant
    // ids throw permission_denied); liveness is checked AFTER the grant so
    // the op never becomes a cross-grant existence oracle (#5891).
    const sourceIdParam = parseSourceIdParam(p.source_id, 'find_orphans', { allowAll: true });
    const explicit = sourceIdParam !== undefined && sourceIdParam !== ALL_SOURCES;
    const scope = await readPolicyOpts(ctx, explicit ? federatedSearchScope(ctx, sourceIdParam) : undefined);
    await assertExplicitSourceLive(ctx, sourceIdParam);
    // #5891: default page size so a multi-source brain can't return a
    // megabyte-scale single response; limit caps at 1000, offset pages in.
    const limit = Math.min(Math.max(0, Number(p.limit) || 200), 1000);
    const offset = Math.max(0, Number(p.offset) || 0);
    const result = await findOrphans(ctx.engine, {
      includePseudo: (p.include_pseudo as boolean) || false,
      ...(mode ? { mode } : {}),
      limit,
      offset,
      ...scope,
    });

    return result;
  },
  cliHints: { name: 'orphans', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const orphansOperations: Operation[] = [find_orphans];
