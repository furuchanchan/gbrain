// #5693 — `gbrain upgrade` on a bun-link install ran `git pull` + `bun
// install` under one try/catch with a 120s cap. When the postinstall
// apply-migrations overran the cap the command printed "Auto-upgrade
// failed" even though the swap already landed — and the printed advice
// invited a second apply-migrations in parallel with the still-running one.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../src/version.ts';

const REPO = resolve(import.meta.dir, '..');

/** Fake bun-link checkout + stub git/bun/gbrain binaries on PATH. */
function makeBunLinkHome(opts: { repoVersion: string; bunInstallExit: number }) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-timeout-'));
  const repo = join(home, 'repo');
  const bin = join(home, 'bin');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/garrytan/gbrain.git\n');
  writeFileSync(join(repo, 'VERSION'), `${opts.repoVersion}\n`);
  writeFileSync(join(repo, 'driver.ts'),
    `const { runUpgrade } = await import(${JSON.stringify(join(REPO, 'src/commands/upgrade.ts'))});\nawait runUpgrade([]);\n`);
  writeFileSync(join(bin, 'git'),
    `#!/bin/sh\nprintf 'git:%s\\n' "$*" >> "$HOME/calls.log"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'bun'),
    `#!/bin/sh\nprintf 'bun:%s\\n' "$*" >> "$HOME/calls.log"\nexit ${opts.bunInstallExit}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'gbrain'),
    `#!/bin/sh\nprintf 'gbrain:%s\\n' "$*" >> "$HOME/calls.log"\nif [ "$1" = '--version' ]; then echo 'gbrain ${opts.repoVersion}'; fi\nexit 0\n`, { mode: 0o755 });
  return { home, repo, driver: join(repo, 'driver.ts') };
}

function runDriver(home: string, driver: string) {
  return spawnSync(process.execPath, ['--no-env-file', driver], {
    cwd: home,
    env: { HOME: home, GBRAIN_HOME: join(home, '.gbrain'), PATH: `${join(home, 'bin')}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 60_000,
  });
}

describe('#5693 bun-link upgrade messaging', () => {
  test('install failure after a landed swap warns about the in-flight postinstall instead of claiming failure', () => {
    const { home, driver } = makeBunLinkHome({ repoVersion: '9.99.9', bunInstallExit: 1 });
    try {
      const r = runDriver(home, driver);
      const out = r.stdout + r.stderr;
      expect(out).toContain('swap to v9.99.9 completed');
      expect(out).toContain('may still be running');
      expect(out).toContain('Do NOT start a second apply-migrations');
      expect(out).not.toContain('Auto-upgrade failed');
      expect(r.status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('install failure with an unchanged checkout still reports a real upgrade failure', () => {
    const { home, driver } = makeBunLinkHome({ repoVersion: VERSION, bunInstallExit: 1 });
    try {
      const r = runDriver(home, driver);
      const out = r.stdout + r.stderr;
      expect(out).toContain('Auto-upgrade failed during `bun install`');
      expect(out).not.toContain('may still be running');
      expect(r.status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
