import type { BrainEngine } from '../engine.ts';

/**
 * `cycle.lint_exclude` (default unset): comma-separated dir/file basenames
 * the cycle's lint phase skips while collecting pages — the same semantics
 * as `gbrain lint --exclude` (#2649), so a repo that keeps non-page
 * markdown next to its pages (an attachments folder, generated docs)
 * lints cleanly in both places. A config read failure keeps the default
 * (no extra exclusions). `gbrain lint --exclude` is unaffected. Its own
 * module for the same reason as lint-fix-setting.ts: the cycle reads the
 * setting without depending on the lint command's export surface.
 */
export async function cycleLintExcludes(engine?: BrainEngine | null): Promise<string[]> {
  const raw = await engine?.getConfig('cycle.lint_exclude').catch(() => null);
  return (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
}
