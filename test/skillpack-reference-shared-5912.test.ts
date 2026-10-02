/**
 * #5912: `skillpack reference --harness <h>` with no skill named took its slug
 * list straight from the bridge-state ledger — including the `_shared`
 * pseudo-slug that owns shared-dep files — and failed with
 * "Skill(s) not listed in skills/manifest.json: _shared". The slug list now
 * comes from `bridgeWrittenSlugs`, which never enumerates the ledger key
 * (the same rule remove and collectBridgesStatus already apply).
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadBridgeState, saveBridgeState, findBridgeEntry, SKILLPACK_BRIDGE_SCHEMA_VERSION } from '../src/core/skillpack/bridge-state.ts';
import type { BridgeEntry } from '../src/core/skillpack/bridge-state.ts';
import { bridgeWrittenSlugs, SHARED_DEP_LEDGER_KEY } from '../src/core/skillpack/harness-bridge.ts';

function entryWith(written: BridgeEntry['written']): BridgeEntry {
  return {
    harness: 'claude-code',
    dest: '/tmp/skills',
    last_persona: null,
    last_mode: 'stub',
    written,
    gbrain_version: '0.60.31.0',
    installed_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
  };
}

const rec = () => ({ mode: 'stub' as const, files: { 'SKILL.md': 'a'.repeat(64) } });

describe('#5912 bridgeWrittenSlugs never enumerates the _shared ledger key', () => {
  test('shared-dep records are excluded; real slugs stay sorted', () => {
    const entry = entryWith({ zebra: rec(), [SHARED_DEP_LEDGER_KEY]: rec(), alpha: rec() });
    expect(bridgeWrittenSlugs(entry)).toEqual(['alpha', 'zebra']);
  });

  test('a _shared-only ledger yields an empty list, not the pseudo-slug', () => {
    const entry = entryWith({ [SHARED_DEP_LEDGER_KEY]: rec() });
    expect(bridgeWrittenSlugs(entry)).toEqual([]);
  });

  test('round-trips through the real ledger: loadBridgeState + findBridgeEntry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-5912-'));
    try {
      const statePath = join(dir, 'skillpack-bridge-state.json');
      saveBridgeState(
        { schema_version: SKILLPACK_BRIDGE_SCHEMA_VERSION, entries: [entryWith({ capture: rec(), [SHARED_DEP_LEDGER_KEY]: rec() })] },
        { statePath },
      );
      const entry = findBridgeEntry(loadBridgeState({ statePath }), { harness: 'claude-code', dest: '/tmp/skills' });
      expect(entry).toBeTruthy();
      expect(bridgeWrittenSlugs(entry!)).toEqual(['capture']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
