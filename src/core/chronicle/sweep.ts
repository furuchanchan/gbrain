// Life Chronicle (#2390) — the auto_chronicle sweep (#5876). The put_page
// chronicle backstop lost its caller in v0.51.0.0, so `auto_chronicle=true`
// has enqueued zero chronicle_extract jobs since: the module
// (chronicle/backstop.ts), the config key, and the advisor text all survived,
// the trigger did not. The cycle is the durable seam — per-source autopilot
// cycles (managed brains included) run the extract phase, and enqueueing is
// a plain minion_jobs insert needing no writer capability.
//
// Forward-only contract: a stored keyset cursor bounds each scan, and every
// enqueue carries a producer idempotency_key so a rescanned boundary page
// cannot enqueue a duplicate (chronicle_extract is not idempotent — #5329).
import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { isAutoChronicleEnabled } from './config.ts';
import { isChronicleEligible } from './eligibility.ts';

/** Config keys `chronicle.auto_sweep_at.<type>`: keyset cursor `"<updated_at_iso>|<slug>"` per eligible type (the `chronicle.` prefix is registered). */
export const CHRONICLE_SWEEP_WATERMARK_PREFIX = 'chronicle.auto_sweep_at';
/** Max pages scanned per eligible type per sweep — the rest drains next cycle (same bounded philosophy as the stale drain). */
export const CHRONICLE_SWEEP_CAP = 200;

const SWEEP_TYPES: PageType[] = ['meeting', 'conversation', 'calendar-event'];

export interface ChronicleSweepResult {
  skipped?: string;
  scanned: number;
  enqueued: number;
  errors: number;
}

export async function sweepChronicleCandidates(
  engine: BrainEngine,
  opts: { sourceId?: string; cap?: number } = {},
): Promise<ChronicleSweepResult> {
  const empty = { scanned: 0, enqueued: 0, errors: 0 };
  if (!(await isAutoChronicleEnabled(engine))) return { ...empty, skipped: 'auto_chronicle_off' };
  // The job needs a chat judge — enqueueing during an outage burns jobs that
  // fail-and-die; the loops enqueue names this same skip reason.
  const { isAvailable } = await import('../ai/gateway.ts');
  if (!isAvailable('chat')) return { ...empty, skipped: 'chat_unavailable' };
  const cap = opts.cap ?? CHRONICLE_SWEEP_CAP;
  const { MinionQueue } = await import('../minions/queue.ts');
  const queue = new MinionQueue(engine);
  let scanned = 0, enqueued = 0, errors = 0;
  for (const type of SWEEP_TYPES) {
    const wmRaw = await engine.getConfig(`${CHRONICLE_SWEEP_WATERMARK_PREFIX}.${type}`).catch(() => null);
    const [wmTs, wmSlug] = typeof wmRaw === 'string' ? wmRaw.split('|') : [];
    const keyset = wmTs && wmSlug !== undefined ? { updatedAt: wmTs, slug: wmSlug } : undefined;
    const pages = await engine.listPages({
      type,
      ...(keyset ? { updatedAfterKeyset: keyset } : {}),
      sourceId: opts.sourceId,
      limit: cap,
      sort: 'updated_asc',
    });
    for (const page of pages) {
      scanned++;
      const dreamGenerated = (page.frontmatter as Record<string, unknown> | undefined)?.dream_generated === true;
      if (!isChronicleEligible({ type: page.type, slug: page.slug, body: page.compiled_truth, dreamGenerated }).ok) continue;
      try {
        // Keyed on the page revision: a rescan of this exact revision dedupes;
        // a real content change (new updated_at) is a fresh extraction intent.
        await queue.add('chronicle_extract', { slug: page.slug, sourceId: page.source_id },
          { idempotency_key: `chronicle:${page.source_id}:${page.slug}:${page.updated_at_iso ?? '0'}` });
        enqueued++;
      } catch { errors++; }
    }
    const last = pages[pages.length - 1];
    if (last?.updated_at_iso) {
      // Advance to the last scanned row regardless of enqueue outcome: an
      // ineligible page must not pin the cursor forever, and an enqueued one
      // dedupes by key if it rescans. Pages updated mid-sweep land strictly
      // after their own updated_at and re-candidate next cycle.
      await engine.setConfig(`${CHRONICLE_SWEEP_WATERMARK_PREFIX}.${type}`, `${last.updated_at_iso}|${last.slug}`).catch(() => {});
    }
  }
  return { scanned, enqueued, errors };
}
