/**
 * #6402: the operator contract for a lane-group knock-on. A `cancelled` request
 * whose message is the window teardown text classifies `transient` /
 * `safe_actions: [retry]` / `needs_human: false`, and `next` is the sync's own
 * `Next:` argv — never more pessimistic than stdout. Cancelled members name
 * their group leader and a cancelled head names the request it follows, so
 * `persistence_requests` shows the culprit. The failure ledger's `attempts` /
 * `first_seen` are per observation (a new observation starts a fresh row), and
 * a caller-side `invalid_params` refusal is never recorded as a sync failure.
 * Synthetic content.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { WINDOW_CANCEL_MESSAGE, isWindowKnockOn, windowCancelMessage, windowLeaderCancelMessage } from '../src/core/persistence/sync-window.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-knock-on-'));
let engine: BrainEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture'); };
async function fixture(files: Record<string, string>) {
  const id = `ko-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); await makeGitFixture(root);
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}
const record = (over: Record<string, unknown>) => recordManagedSyncFailure(engine, {
  source_id: 'src', source_incarnation: randomUUID(), path: 'a.md', code: 'cancelled', message: WINDOW_CANCEL_MESSAGE,
  request_id: null, run_id: 'run', target: null, cursor_key: 'key', phase: 'receipt', state: 'cancelled',
  observation_id: 'obs', ...over } as Parameters<typeof recordManagedSyncFailure>[1]);

beforeAll(async () => { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('cancel messages: a member names its group leader; a head names the request it follows', () => {
  const member = { request_id: 'm-req', intent: { group: 'leader-req' } };
  expect(windowCancelMessage(member)).toContain('Group leader: leader-req');
  const head = { request_id: 'leader-req', intent: { group: 'leader-req' } };
  const message = windowCancelMessage(head, { predecessorId: 'gone-req', predecessorState: 'missing' });
  expect(message).toContain('gone-req');
  expect(message).toContain('missing');
  expect(message).not.toContain('earlier page');
  expect(windowCancelMessage({ request_id: 'solo', intent: {} })).toBe(WINDOW_CANCEL_MESSAGE);
  for (const text of [WINDOW_CANCEL_MESSAGE, message, windowCancelMessage(member)]) expect(isWindowKnockOn(text)).toBe(true);
  expect(isWindowKnockOn('The accepted sync request did not commit.')).toBe(false);
});

test('classifier: a window-knock-on cancelled request is transient with a retry; other cancelled stays human', () => {
  for (const message of [WINDOW_CANCEL_MESSAGE, windowLeaderCancelMessage('pred', 'failed'), `${WINDOW_CANCEL_MESSAGE} Group leader: x.`]) {
    expect(classifySyncFault({ code: 'cancelled', message })).toEqual({ class: 'transient', safe_actions: ['retry'], needs_human: false });
  }
  const other = classifySyncFault({ code: 'cancelled', message: 'The accepted sync request did not commit.' });
  expect(other.class).toBe('systemic');
  expect(other.needs_human).toBe(true);
});

test('failure ledger: attempts and first_seen are per observation; a new observation starts a fresh row', async () => {
  const first = await record({ first_seen: '2026-09-24T16:35:09.000Z' });
  expect(first.failure.attempts).toBe(1);
  const again = await record({ first_seen: '2026-09-24T16:35:09.000Z' });
  expect(again.failure.attempts).toBe(2);
  expect(again.failure.first_seen).toBe('2026-09-24T16:35:09.000Z');
  const fresh = await record({ observation_id: 'obs-2', first_seen: '2026-10-10T03:38:00.000Z' });
  expect(fresh.failure.attempts).toBe(1);
  expect(fresh.failure.first_seen).toBe('2026-10-10T03:38:00.000Z');
});

test('sync status: a recorded knock-on reports transient/retry and names --retry-failed, never needs_human', async () => {
  const f = await fixture({ 'a.md': 'First synthetic observation.\n', 'b.md': 'Second synthetic observation.\n' });
  const partial = await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 1000 });
  expect(partial.status).toBe('partial');
  const [cursor] = await engine.executeRaw<{ fingerprint: string }>(`SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [f.id]);
  await record({ source_id: f.id, source_incarnation: (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [f.id]))[0]!.i,
    cursor_key: cursor.fingerprint });
  const status = await readSyncStatus(engine, f.id);
  expect(status.last_error?.code).toBe('cancelled');
  expect(status.last_error?.class).toBe('transient');
  expect(status.last_error?.needs_human).toBe(false);
  expect(status.needs_human).toBe(false);
  expect(status.next?.argv).toContain('--retry-failed');
});

test('a caller options conflict is refused without writing the failure ledger', async () => {
  const f = await fixture({ 'a.md': 'First synthetic observation.\n', 'b.md': 'Second synthetic observation.\n' });
  expect((await performManagedSync(engine, f.opts, { maxPages: 1, maxMs: 1000 })).status).toBe('partial');
  const [cursor] = await engine.executeRaw<{ fingerprint: string }>(`SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1`, [f.id]);
  // The stored cursor's noEmbed/noExtract differ from this call's options: a caller error, not a sync failure.
  await expect(performManagedSync(engine, { sourceId: f.id, noPull: true })).rejects.toMatchObject({ code: 'invalid_params' });
  expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1", [cursor.fingerprint])).toEqual([]);
});
