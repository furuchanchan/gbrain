// #5855: the self-upgrade must skip a target whose declared Bun floor the
// host cannot meet — the post-swap `gbrain --version` smoke check answers
// exit 0 by design on an unsupported runtime, so it cannot catch this.
// These tests fail on pre-fix trees at the first `typeof` assertion (the
// helpers do not exist yet) and pass once the gate is wired in.

import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as upgrade from '../src/commands/upgrade.ts';

describe('upgrade bun floor (#5855)', () => {
  test('bunFloorFromPackageJson extracts engines.bun, tolerates garbage', () => {
    expect(typeof upgrade.bunFloorFromPackageJson).toBe('function');
    expect(upgrade.bunFloorFromPackageJson('{"engines":{"bun":">=1.4.0"}}')).toBe('>=1.4.0');
    expect(upgrade.bunFloorFromPackageJson('{"engines":{"bun":">=1.4.0 <2"}}')).toBe('>=1.4.0 <2');
    expect(upgrade.bunFloorFromPackageJson('{"engines":{}}')).toBeNull();
    expect(upgrade.bunFloorFromPackageJson('{}')).toBeNull();
    expect(upgrade.bunFloorFromPackageJson('not json')).toBeNull();
    expect(upgrade.bunFloorFromPackageJson('')).toBeNull();
  });

  test('bunFloorSatisfied gates on the host runtime, fails open on unknowns', () => {
    expect(typeof upgrade.bunFloorSatisfied).toBe('function');
    // The #5855 report: 0.60.27.0 raised the floor to >=1.4.0 on a Bun 1.3.14 host.
    expect(upgrade.bunFloorSatisfied('>=1.4.0', '1.3.14')).toBe(false);
    expect(upgrade.bunFloorSatisfied('>=1.4.0', '1.4.0')).toBe(true);
    expect(upgrade.bunFloorSatisfied('>=1.4.0', '1.9.9')).toBe(true);
    expect(upgrade.bunFloorSatisfied('>=1.4.0 <2', '2.0.0')).toBe(false);
    // Fail-open contract: an unreadable floor must never block an upgrade.
    expect(upgrade.bunFloorSatisfied(null, '1.3.14')).toBe(true);
    expect(upgrade.bunFloorSatisfied('not-a-range', '1.3.14')).toBe(true);
    expect(upgrade.bunFloorSatisfied('>=1.4.0', 'weird-host')).toBe(true);
  });

  test('readBunFloorFromFetchedRef reads the incoming tree package.json', () => {
    expect(typeof upgrade.readBunFloorFromFetchedRef).toBe('function');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-5855-'));
    try {
      const remote = join(dir, 'remote.git');
      const work = join(dir, 'work');
      const clone = join(dir, 'clone');
      execFileSync('git', ['init', '--bare', remote]);
      execFileSync('git', ['init', work]);
      execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
      execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
      writeFileSync(join(work, 'package.json'), '{"name":"x","engines":{"bun":">=1.0.0"}}');
      execFileSync('git', ['-C', work, 'add', 'package.json']);
      execFileSync('git', ['-C', work, 'commit', '-m', 'init']);
      execFileSync('git', ['-C', work, 'push', remote, 'HEAD:main']);
      execFileSync('git', ['clone', remote, clone]);
      // Raise the floor upstream, then fetch in the clone — FETCH_HEAD now
      // carries the incoming release's package.json, not the checked-out one.
      writeFileSync(join(work, 'package.json'), '{"name":"x","engines":{"bun":">=99.0.0"}}');
      execFileSync('git', ['-C', work, 'commit', '-am', 'bump floor']);
      execFileSync('git', ['-C', work, 'push', remote, 'HEAD:main']);
      execFileSync('git', ['-C', clone, 'fetch']);
      expect(upgrade.readBunFloorFromFetchedRef(clone)).toBe('>=99.0.0');
      // Sanity: the gate refuses it on a real host Bun.
      expect(upgrade.bunFloorSatisfied(upgrade.readBunFloorFromFetchedRef(clone))).toBe(false);
      // Fail-open: a directory that is not a fetched repo yields no floor.
      expect(upgrade.readBunFloorFromFetchedRef(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
