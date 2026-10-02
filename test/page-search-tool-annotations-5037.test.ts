/**
 * #5037 — the core page and search ops carry ToolAnnotations so an
 * annotation-driven approval policy can tell a read from a write. Previously
 * only the memory verbs + recall/context_pack/delta/loops_close were
 * annotated, so a per-tool approval mode degraded to "prompt every time" on
 * the reads an agent calls constantly.
 *
 * Asserts the declared annotations on the ops AND that buildToolDefs emits
 * them through the real emission seam (not a re-declared map).
 */
import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';

const EXPECTED: Record<string, { readOnly?: boolean; destructive?: boolean; idempotent?: boolean }> = {
  get_page: { readOnly: true },
  fetch: { readOnly: true },
  list_pages: { readOnly: true },
  search: { readOnly: true },
  query: { readOnly: true },
  search_stats: { readOnly: true },
  search_modes: { readOnly: true },
  search_tune: { readOnly: true },
  cache_stats: { readOnly: true },
  put_page: { idempotent: true },
  capture: { idempotent: true },
  restore_page: { idempotent: true },
  delete_page: { destructive: true, idempotent: true },
};

describe('#5037 page/search op ToolAnnotations', () => {
  test('every core page/search read op declares readOnlyHint; write ops carry the matching hints', () => {
    for (const [name, hints] of Object.entries(EXPECTED)) {
      const op = operations.find(o => o.name === name);
      expect(op, `op ${name} missing`).toBeTruthy();
      const ann = op!.annotations;
      expect(ann, `op ${name} has no annotations`).toBeTruthy();
      expect(ann!.title, `op ${name} has no title`).toBeTruthy();
      expect(ann!.readOnlyHint ?? false).toBe(hints.readOnly ?? false);
      expect(ann!.destructiveHint ?? false).toBe(hints.destructive ?? false);
      expect(ann!.idempotentHint ?? false).toBe(hints.idempotent ?? false);
    }
  });

  test('buildToolDefs emits the annotations key for every annotated op', () => {
    const defs = buildToolDefs(operations);
    for (const name of Object.keys(EXPECTED)) {
      const def = defs.find(d => d.name === name);
      expect(def, `tool def ${name} missing`).toBeTruthy();
      expect(def!.annotations, `tool def ${name} lacks emitted annotations`).toBeTruthy();
      expect(def!.annotations!.readOnlyHint ?? false).toBe(EXPECTED[name].readOnly ?? false);
    }
  });
});
