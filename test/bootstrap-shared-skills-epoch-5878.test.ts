import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyHarness, parseHarnessArgs, refreshHarnessSharedSkills, statusHarness, type HarnessDeps } from '../src/core/bootstrap/harness.ts';
import { readHarnessReceiptState, type HarnessReceipt } from '../src/core/bootstrap/format.ts';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../src/core/shared-skills/adapter.ts';
import { installSharedSkillsConnection } from '../src/core/harness/shared-skills.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const flags = (...args: string[]) => parseHarnessArgs(['--yes', '--no-hooks', '--harness', 'codex', ...args]);

// The memberships stub tracks a server-side epoch per principal the way
// membership.ts does: every join_brain bumps it (a re-enroll narrows the
// follow policy and supersedes the recorded epoch), and sync/leave with an
// old epoch is refused `membership_inactive`. `serverCall` simulates an MCP
// client (outside the bootstrap flow) re-enrolling the same principal.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-epoch-5878-'));
  roots.push(root);
  const home = join(root, 'gbrain');
  const brain = randomUUID();
  const mints: Array<Parameters<NonNullable<HarnessDeps['mint']>>[0] & { id: string; token: string }> = [];
  const revoked: string[] = [];
  const output: string[] = [];
  const memberships = new Map<string, { id: string; active: boolean; epoch: number }>();
  const receipt = (): HarnessReceipt => {
    const state = readHarnessReceiptState(home);
    if (state.state !== 'ok') throw new Error('missing fixture receipt');
    return state.receipt;
  };
  const snapshot = (member: { id: string; epoch: number }) => ({
    schema_version: 2, complete: true, status: 'catalog_visible', brain_id: brain, installation_id: member.id,
    enrollment_epoch: member.epoch, view_token: 'fixture-view', batch_token: 'fixture-batch', sequence: member.epoch, skills: [], blocked_skills: [],
    delivery: { native: 'unverified', freshness: 'session_refresh' },
  });
  const serverCall = async (principal: string, name: string, params: Record<string, unknown> = {}) => {
    if (!memberships.has(principal)) memberships.set(principal, { id: randomUUID(), active: false, epoch: 0 });
    const member = memberships.get(principal)!;
    if (name === 'join_brain') { member.active = true; member.epoch += 1; return snapshot(member); }
    if (name === 'sync_brain_skills') {
      if (!member.active || member.epoch !== params.enrollment_epoch) {
        throw new OperationError('membership_inactive', 'Membership was left or superseded.');
      }
      return snapshot(member);
    }
    if (name === 'leave_brain') {
      if (member.epoch !== params.enrollment_epoch) {
        throw new OperationError('membership_inactive', 'This enrollment epoch has already been superseded.');
      }
      member.active = false;
      return { status: 'left', installation_id: member.id, enrollment_epoch: member.epoch };
    }
    throw new Error(`unstubbed op ${name}`);
  };
  const deps: HarnessDeps = {
    gbrainHome: home, isTTY: false, gbrainBin: '/synthetic/gbrain',
    userSettingsPath: join(root, 'claude', 'settings.json'), codexConfig: join(root, 'codex', 'config.toml'),
    opencodeConfig: join(root, 'opencode', 'opencode.json'), loadFileConfig: () => null,
    nativeSkillsDir: host => join(root, host, 'skills'),
    detectClaude: () => true, detectCodex: () => true, detectOpencode: () => true,
    resolveHookSource: async explicit => ({ source_id: explicit ?? 'workspace', grant: explicit ? [explicit] : ['workspace', 'shared'] }),
    fetchFn: (async () => new Response(JSON.stringify({ status: 'ok', engine: 'postgres', version: '0.51.7.0' }))) as unknown as typeof fetch,
    probeIdentity: async (_url, token) => mints.some(m => m.token === token)
      ? { ok: true, identity: 'fixture brain' } : { ok: false, reason: 'auth', message: 'denied' },
    mint: async options => {
      const result = { ...options, id: randomUUID(), token: `gbrain_${randomUUID().replaceAll('-', '').repeat(2)}` };
      mints.push(result);
      return result;
    },
    revokeById: async id => { revoked.push(id); return true; },
    pgliteLiveServe: () => false,
    runner: async argv => ({ code: argv[0] === 'claude' && argv[2] === 'get' ? 1 : 0, stdout: '', stderr: '' }),
    installSharedSkills: async (credentials, options) => {
      const call: SharedSkillsToolCaller = <T>(name: string, params: Record<string, unknown>) =>
        serverCall(credentials.access_token!, name, params) as Promise<T>;
      return installSharedSkillsConnection(credentials, { ...options, toolCaller: call });
    },
    log: text => output.push(text), logError: text => output.push(text),
  };
  return { root, home, deps, mints, revoked, output, memberships, receipt, serverCall };
}

test('--refresh-skills parses and conflicts with --status/--remove like the other modes', () => {
  expect(flags('--refresh-skills').refreshSkills).toBe(true);
  expect(flags('--refresh-skills', '--status').error).toContain('--refresh-skills alone');
  expect(flags('--refresh-skills', '--remove').error).toContain('--refresh-skills alone');
});

test('the adapter leave treats a superseded epoch as already-inactive remote cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-epoch-5878-adapter-'));
  roots.push(root);
  const member = { id: randomUUID(), epoch: 3 };
  const adapter = createSharedSkillsAdapter({
    root: join(root, 'shared-skills'), adapter: 'codex',
    call: async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
      if (name === 'join_brain') return { schema_version: 2, complete: true, status: 'catalog_visible', brain_id: 'b', installation_id: member.id,
        enrollment_epoch: member.epoch, view_token: 'v', batch_token: 't', sequence: member.epoch, skills: [], blocked_skills: [],
        delivery: { native: 'unverified', freshness: 'session_refresh' } } as T;
      if (name === 'sync_brain_skills') {
        if (params.enrollment_epoch !== member.epoch) throw new OperationError('membership_inactive', 'Membership was left or superseded.');
        return { schema_version: 2, complete: true, status: 'catalog_visible', brain_id: 'b', installation_id: member.id,
          enrollment_epoch: member.epoch, view_token: 'v', batch_token: 't', sequence: member.epoch, skills: [], blocked_skills: [],
          delivery: { native: 'unverified', freshness: 'session_refresh' } } as T;
      }
      if (name === 'leave_brain') {
        if (params.enrollment_epoch !== member.epoch) throw new OperationError('membership_inactive', 'This enrollment epoch has already been superseded.');
        return { status: 'left' } as T;
      }
      throw new Error(`unstubbed op ${name}`);
    },
  });
  await adapter.join({ approved: true });
  // The server epoch moved on (an MCP re-enroll) — the recorded epoch is stale.
  member.epoch = 4;
  const left = await adapter.leave();
  expect(left.status).toBe('left');
  const saved = JSON.parse(readFileSync(join(root, 'shared-skills', 'receipt.json'), 'utf8'));
  expect(saved.remote_membership_pending).toBe(false);
  expect(saved.remote_membership_reason).toBe('superseded');
});

test('--status flags a superseded epoch and --refresh-skills adopts the server epoch', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'codex'), { recursive: true });
  writeFileSync(join(f.root, 'codex', 'AGENTS.md'), 'Preserve this agent identity.');
  expect(await applyHarness(flags('--source', 'workspace', '--no-capture'), f.deps)).toBe(0);
  const entry = f.receipt().shared_skills![0];
  expect(entry.server_epoch).toBe(1);
  expect(JSON.parse(readFileSync(join(entry.root, 'shared-skills', 'receipt.json'), 'utf8')).enrollment_epoch).toBe(1);

  // An MCP client re-enrolls the same principal: the server epoch moves on.
  const token = f.mints[0].token;
  await f.serverCall(token, 'join_brain', { adapter: 'codex', follow_policy: { approved: true, source_ids: ['workspace'] } });
  expect(f.memberships.get(token)!.epoch).toBe(2);

  expect(await statusHarness(flags('--status'), f.deps)).toBe(0);
  const staleLine = f.output.find(line => line.includes('shared skills (codex):') && line.includes('STALE'));
  expect(staleLine).toContain('recorded 1 superseded');
  expect(staleLine).toContain('--refresh-skills');

  expect(await refreshHarnessSharedSkills(flags('--refresh-skills'), f.deps)).toBe(0);
  expect(JSON.parse(readFileSync(join(entry.root, 'shared-skills', 'receipt.json'), 'utf8')).enrollment_epoch).toBe(3);
  expect(f.output.some(line => line.includes('enrollment epoch 1 → 3') && line.includes('superseded'))).toBe(true);
  expect(f.receipt().shared_skills![0].server_epoch).toBe(3);

  expect(await statusHarness(flags('--status'), f.deps)).toBe(0);
  expect(f.output.at(-1) === undefined).toBe(false);
  const currentLine = [...f.output].reverse().find(line => line.includes('shared skills (codex):'));
  expect(currentLine).toContain('enrollment epoch 3 current');
});

test('status --json reports enrollment_stale per entry, then clears after refresh', async () => {
  const f = fixture();
  expect(await applyHarness(flags('--source', 'workspace'), f.deps)).toBe(0);
  await f.serverCall(f.mints[0].token, 'join_brain', { adapter: 'codex', follow_policy: { approved: true } });

  expect(await statusHarness(flags('--status', '--json'), f.deps)).toBe(0);
  const stale = JSON.parse(f.output.at(-1)!);
  expect(stale.shared_skills[0].enrollment_stale).toBe(true);
  expect(stale.shared_skills[0].enrollment_epoch).toBe(1);
  expect(stale.shared_skills[0].enrollment_server_epoch).toBeNull();

  expect(await refreshHarnessSharedSkills(flags('--refresh-skills'), f.deps)).toBe(0);
  expect(await statusHarness(flags('--status', '--json'), f.deps)).toBe(0);
  const current = JSON.parse(f.output.at(-1)!);
  expect(current.shared_skills[0].enrollment_stale).toBe(false);
  expect(current.shared_skills[0].enrollment_server_epoch).toBe(3);
});

test('a harness re-apply converges when the old enrollment epoch was superseded', async () => {
  const f = fixture();
  expect(await applyHarness(flags('--source', 'workspace'), f.deps)).toBe(0);
  const firstToken = f.mints[0].token;
  // The same principal re-enrolled over MCP — its recorded epoch is stale.
  await f.serverCall(firstToken, 'join_brain', { adapter: 'codex', follow_policy: { approved: true } });
  await f.serverCall(firstToken, 'join_brain', { adapter: 'codex', follow_policy: { approved: true } });

  // Re-apply mints a fresh principal; the old entry's leave runs with the
  // stale epoch and the server refuses — superseded, so cleanup converges.
  expect(await applyHarness(flags('--source', 'workspace'), f.deps)).toBe(0);
  const receipt = f.receipt();
  expect(receipt.token.previous_ids ?? []).toEqual([]);
  expect(f.revoked).toContain(f.mints[0].id);
  expect(f.output.join('\n')).not.toContain('remote membership deactivation is pending');
  expect(receipt.shared_skills?.every(entry => !entry.status.startsWith('pending'))).toBe(true);
});

test('refresh reports credentials that no longer name the installation endpoint', async () => {
  const f = fixture();
  expect(await applyHarness(flags('--source', 'workspace'), f.deps)).toBe(0);
  const entry = f.receipt().shared_skills![0];
  const stale = JSON.parse(readFileSync(join(entry.root, 'credentials.json'), 'utf8'));
  stale.mcp_url = 'http://elsewhere.example/mcp';
  writeFileSync(join(entry.root, 'credentials.json'), JSON.stringify(stale));
  expect(await refreshHarnessSharedSkills(flags('--refresh-skills'), f.deps)).toBe(1);
  expect(f.receipt().shared_skills![0].reason).toBe('credentials_unavailable');
});
