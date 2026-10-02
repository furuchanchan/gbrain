/**
 * #5559 — `gbrain eval suspected-contradictions --help` printed the
 * generic `gbrain eval` usage (the --qrels stub) instead of the probe's
 * own help: the dispatcher's per-command --help interception called
 * `printOpHelp` before the subcommand could see the flag. The probe now
 * joins brainbench's self-help exception, and — like the
 * SELF_HELP_WITHOUT_ENGINE members — answers with no brain configured.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;

describe('eval suspected-contradictions --help (#5559)', () => {
  test('prints the probe\'s own usage with no brain configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-nobrain-'));
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    const proc = Bun.spawn(
      ['bun', '--no-env-file', 'run', 'src/cli.ts', 'eval', 'suspected-contradictions', '--help'],
      { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const out = stdout + stderr;
    expect(code).toBe(0);
    // The probe's own printHelp — usage lines the generic stub never emits.
    expect(out).toContain('gbrain eval suspected-contradictions [run]');
    expect(out).toContain('--from-capture');
    // The generic eval stub's qrels usage must NOT answer this flag.
    expect(out).not.toContain('--qrels <path|json>');
  }, 30_000);
});
