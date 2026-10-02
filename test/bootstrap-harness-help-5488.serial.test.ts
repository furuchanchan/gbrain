/**
 * `gbrain bootstrap harness --help` must print usage instead of applying (#5488).
 *
 * `harness` was added to the bootstrap KNOWN subcommands AFTER the generic
 * subcommand-help gate landed, but never received a SUBCOMMAND_HELP entry —
 * so `bootstrap harness --help` fell through the `Object.hasOwn` check into
 * `runHarness` → `parseHarnessArgs` (which ignores the token) →
 * `ensureHarnessHome` (mkdir <home>/bootstrap) → `applyHarness`, which mints
 * a scoped bearer token and writes MCP/hook config. The reporter's symptom:
 * asking for help ran the real wiring.
 *
 * Each case asserts the interception returns 0 with usage text, leaves the
 * runner's exec log empty, and creates none of the real run's first
 * observable artifacts (`<home>/bootstrap` dir, install.jsonl phase entry).
 * The --status case proves the real dispatch still reaches `statusHarness`
 * once the guard entry exists.
 *
 * Serial: mutates GBRAIN_HOME.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap } from '../src/commands/bootstrap.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import { readInstallLog } from '../src/core/bootstrap/status.ts';

let tmpParent: string; // GBRAIN_HOME parent (configDir appends .gbrain)
let home: string;
let prevHome: string | undefined;

function makeRunner(): { runner: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ExecRunner = async (argv: string[]) => {
    calls.push(argv);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: unknown[]) => {
    err += args.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeAll(() => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-harness-help-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
});

describe('bootstrap harness --help/-h/help prints usage instead of wiring (#5488)', () => {
  test('--help: usage text, exit 0, zero exec calls, no <home>/bootstrap dir or install-log entry', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['harness', '--help'], { runner }));

    expect(r.result).toBe(0);
    expect(r.out).toContain('framework-spawned');
    expect(r.out).toContain('--remove');
    expect(calls.length).toBe(0);
    // A real (unguarded) apply creates <home>/bootstrap via ensureHarnessHome
    // BEFORE its health probe can fail — it must still be absent.
    expect(existsSync(join(home, 'bootstrap'))).toBe(false);
    expect(readInstallLog(home, 1000).length).toBe(0);
  });

  test('-h: same interception (short flag spelling)', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['harness', '-h'], { runner }));

    expect(r.result).toBe(0);
    expect(r.out).toContain('framework-spawned');
    expect(calls.length).toBe(0);
    expect(existsSync(join(home, 'bootstrap'))).toBe(false);
  });

  test('help (bare word): same interception', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['harness', 'help'], { runner }));

    expect(r.result).toBe(0);
    expect(r.out).toContain('framework-spawned');
    expect(calls.length).toBe(0);
    expect(existsSync(join(home, 'bootstrap'))).toBe(false);
  });

  test('harness --remove --yes --help: help wins over every mutating flag combined with it', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['harness', '--remove', '--yes', '--help'], { runner }));

    expect(r.result).toBe(0);
    expect(r.out).toContain('framework-spawned');
    expect(calls.length).toBe(0);
    expect(existsSync(join(home, 'bootstrap'))).toBe(false);
  });

  test('harness --status --help: help wins even over the read-only flag', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['harness', '--status', '--help'], { runner }));

    expect(r.result).toBe(0);
    expect(r.out).toContain('framework-spawned');
    expect(calls.length).toBe(0);
    expect(existsSync(join(home, 'bootstrap'))).toBe(false);
  });

  test('control: harness --status still dispatches to the real read-only path', async () => {
    const { runner, calls } = makeRunner();

    const r = await capture(() => runBootstrap(['harness', '--status'], { runner }));

    // statusHarness on a receipt-less home: the documented absence report,
    // proving the SUBCOMMAND_HELP entry did not swallow real dispatch.
    expect(r.result).toBe(0);
    expect(r.out).toContain('no harness install on this machine');
    expect(calls.length).toBe(0);
  });
});
