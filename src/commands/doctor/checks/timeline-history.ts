/**
 * timeline_history doctor check (#5567): timeline rows that exist only in the
 * database, with no bullet in their page. Materializable rows warn and name
 * `gbrain repair timeline`; rows that cannot round-trip through the page are
 * kept by every writer and reported as informational.
 *
 * Bounded: pages carrying non-event timeline rows are classified in id order
 * up to PAGE_CAP pages or TIME_BUDGET_MS. A truncated scan reports its counts
 * as a lower bound and is never reported as clean.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { scanTimelineHistory } from '../../../core/repair/timeline.ts';

const PAGE_CAP = 2_000;
const TIME_BUDGET_MS = 10_000;

/** Config-table key holding this check's resumable sweep cursor per scope
 *  (#5821). Same idiom as `backfill.*.last_id` in src/core/backfill-base.ts. */
const cursorKey = (sourceId?: string) => `doctor.timeline_history.last_id.${sourceId ?? 'all'}`;

export async function timelineHistoryCheck(engine: BrainEngine, sourceId?: string, opts: { pageCap?: number } = {}): Promise<Check> {
  const name = 'timeline_history';
  try {
    const sources = sourceId ? [sourceId] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE')).map(r => r.id);
    // #5821: a brain with more timeline-bearing pages than one bounded pass can
    // cover used to warn "scan incomplete" forever — every run restarted at id 0.
    // The check now keeps a keyset cursor in `config` and resumes where the last
    // run stopped, so successive runs cover the whole brain and a clean sweep
    // eventually reports ok. Findings RESTART the sweep (cursor cleared): a
    // completing pass must never report ok while rows found by an earlier
    // partial pass could still be unrepaired — the warning re-scans from 0 until
    // the pages are fixed, which is the fail-closed direction.
    let afterId = 0;
    try {
      const stored = await engine.getConfig(cursorKey(sourceId));
      const n = Number(stored ?? '');
      if (Number.isFinite(n) && n > 0) afterId = n;
    } catch { /* best-effort — a config read failure must not break the check */ }
    const scan = await scanTimelineHistory(engine, sources, afterId, { pages: opts.pageCap ?? PAGE_CAP, deadline: Date.now() + TIME_BUDGET_MS });
    const materializable = scan.pages.reduce((n, p) => n + p.materializable, 0);
    const unrenderable = scan.pages.reduce((n, p) => n + p.unrenderable, 0);
    const count = scan.truncated ? 'lower_bound' : 'exact';
    const details = { materializable_rows: materializable, kept_unrenderable_rows: unrenderable, pages_affected: scan.pages.filter(p => p.materializable).length,
      pages_inspected: scan.inspected, count, truncated: scan.truncated, resumed_from: afterId || undefined, repair: 'timeline' };
    const bound = scan.truncated ? `at least ` : '';
    const coverage = scan.truncated ? ` (scan stopped after ${scan.inspected} pages${afterId ? `, resumed from id ${afterId}` : ''}; counts are a lower bound)` : '';
    try {
      if (!scan.truncated || materializable > 0) await engine.unsetConfig(cursorKey(sourceId));
      else await engine.setConfig(cursorKey(sourceId), String(scan.lastId));
    } catch { /* cursor persistence is advisory — never fail the check on it */ }
    if (materializable > 0) {
      return { name, status: 'warn', details, message: `${bound}${materializable} timeline row(s) on ${details.pages_affected} page(s) exist only in the database${coverage}. `
        + `Preview: gbrain repair timeline — apply: gbrain repair timeline --apply` + (unrenderable ? `. ${unrenderable} other row(s) cannot round-trip and are kept as-is.` : '') };
    }
    if (scan.truncated) {
      return { name, status: 'warn', details, message: `Timeline history scan incomplete${coverage}; the next run resumes from id ${scan.lastId} — or run \`gbrain repair timeline\` for the full count.` };
    }
    return { name, status: 'ok', details, message: unrenderable
      ? `No materializable database-only timeline rows; ${unrenderable} row(s) cannot round-trip through their page and are kept as-is (informational).`
      : `Every timeline row has a bullet in its page (${scan.inspected} page(s) inspected).` };
  } catch (e) {
    return { name, status: 'warn', message: `timeline history check skipped: ${e instanceof Error ? e.message : String(e)}`,
      details: { count: 'lower_bound', truncated: true, health: 'unknown' } };
  }
}
