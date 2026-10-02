/**
 * #5868 — grace-hold re-evaluation for quiet Gmail threads.
 *
 * A thread whose ONLY detection blocker is the grace window produces no
 * Gmail history signal when the window lapses (history.list re-lists a
 * thread only on a new message, deletion, or label change). The sweep now
 * persists each held thread's deadline (`gmail_loop_holds` in the connector
 * state) and re-fetches due threads at the end of every sweep — the same
 * seam the item-holds drain (`dueHeldKeys`) already uses.
 *
 * Real PGLite engine + the fake-Gmail sweep harness (same shape as
 * test/google-source-materialize.test.ts). Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type {
  CredentialEntry,
  CredentialMeta,
  CredentialVault,
  ProviderClientRecord,
} from '../src/core/creds/vault.ts';
import type { FetchImpl } from '../src/core/google/google-clients.ts';
import { __clearSuppressionCacheForTests } from '../src/core/google/loop-detect.ts';
import {
  googleStateFile,
  parseGoogleSourceConfig,
  readGoogleState,
  runGoogleSync,
} from '../src/core/google/google-source.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  __clearSuppressionCacheForTests();
});

const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const hoursAgoMs = (n: number): number => NOW_MS - n * 3_600_000;

const T_HOLD = '17aa00000000e005';

interface FakeMessage {
  id: string;
  threadId: string;
  internalDateMs: number;
  headers: Record<string, string>;
  labelIds: string[];
  body: string;
}

interface FakeGoogle {
  profileHistoryId: string;
  messages: FakeMessage[];
  history: string[][];
  historyResponseId: string;
  calls: string[];
  threadFetches: Map<string, number>;
  goneThreads: Set<string>;
  tokenPosts: number;
}

function emptyFx(): FakeGoogle {
  return {
    profileHistoryId: '1000',
    messages: [],
    history: [],
    historyResponseId: '1000',
    calls: [],
    threadFetches: new Map(),
    goneThreads: new Set(),
    tokenPosts: 0,
  };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildFetch(fx: FakeGoogle): FetchImpl {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return async (input: RequestInfo | URL): Promise<Response> => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    fx.calls.push(u.pathname + u.search);

    if (u.hostname === 'oauth2.googleapis.com') {
      fx.tokenPosts++;
      return json({ access_token: 't2', expires_in: 3600 });
    }
    if (u.pathname.endsWith('/users/me/profile')) {
      return json({ emailAddress: 'a@example.com', historyId: fx.profileHistoryId });
    }
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = /after:(\d+)/.exec(q);
      const before = /before:(\d+)/.exec(q);
      let msgs = [...fx.messages];
      if (after) msgs = msgs.filter((m) => Math.floor(m.internalDateMs / 1000) >= Number(after[1]));
      if (before) msgs = msgs.filter((m) => Math.floor(m.internalDateMs / 1000) < Number(before[1]));
      msgs.sort((a, b) => b.internalDateMs - a.internalDateMs);
      return json({ messages: msgs.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    if (u.pathname.endsWith('/users/me/history')) {
      return json({
        historyId: fx.historyResponseId,
        history: fx.history.map((tids) => ({ messages: tids.map((tid) => ({ threadId: tid })) })),
      });
    }
    const threadMatch = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (threadMatch) {
      const tid = threadMatch[1];
      fx.threadFetches.set(tid, (fx.threadFetches.get(tid) ?? 0) + 1);
      if (fx.goneThreads.has(tid)) return json({ error: { code: 404, message: 'Not found' } }, 404);
      const msgs = fx.messages
        .filter((m) => m.threadId === tid)
        .sort((a, b) => b.internalDateMs - a.internalDateMs);
      return json({
        id: tid,
        messages: msgs.map((m) => ({
          id: m.id,
          threadId: tid,
          labelIds: m.labelIds,
          internalDate: String(m.internalDateMs),
          payload: {
            mimeType: 'multipart/alternative',
            headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
            parts: [{ mimeType: 'text/plain', body: { data: b64url(m.body) } }],
          },
        })),
      });
    }
    return json({ error: { message: `unhandled ${u.pathname}` } }, 400);
  };
}

class FakeVault implements CredentialVault {
  entries = new Map<string, CredentialEntry>();
  clients = new Map<string, ProviderClientRecord>();
  async get(id: string): Promise<CredentialEntry | null> {
    return this.entries.get(id) ?? null;
  }
  async put(entry: CredentialEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }
  async list(): Promise<CredentialMeta[]> {
    return [];
  }
  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
  async getClient(provider: string): Promise<ProviderClientRecord | null> {
    return this.clients.get(provider) ?? null;
  }
  async putClient(rec: ProviderClientRecord): Promise<void> {
    this.clients.set(rec.provider, rec);
  }
  async deleteClient(provider: string): Promise<boolean> {
    return this.clients.delete(provider);
  }
}

const CLIENT_ID = '123-abc.apps.googleusercontent.com';

function makeVault(): FakeVault {
  const v = new FakeVault();
  v.entries.set('google:a@example.com', {
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 't',
      refresh_token: 'r',
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    },
    meta: {
      account: 'a@example.com',
      sendas_aliases: ['alias@example.com'],
      connected_at: new Date().toISOString(),
      client_id: CLIENT_ID,
    },
  });
  v.clients.set('google', {
    provider: 'google',
    client_id: CLIENT_ID,
    client_secret: 'GOCSPX-test-secret-0000',
    created_at: new Date().toISOString(),
  });
  return v;
}

async function insertGoogleSource(dir: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    [
      'gsrc',
      'google',
      dir,
      JSON.stringify({
        kind: 'google',
        g_account: 'a@example.com',
        g_services: 'gmail',
        g_history_days: 90,
        g_dir: dir,
      }),
    ],
  );
}

async function sweep(dir: string, fx: FakeGoogle, vault: FakeVault, opts: Partial<SyncOpts> = {}) {
  return runGoogleSync(
    engine,
    'gsrc',
    parseGoogleSourceConfig(
      { kind: 'google', g_account: 'a@example.com', g_services: 'gmail', g_history_days: 90, g_dir: dir },
      dir,
    ),
    { sourceId: 'gsrc', noEmbed: true, noExtract: true, ...opts },
    buildFetch(fx),
    vault,
  );
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);
}

/** Inbound "asks a question" thread: held by the 24h inbound grace. */
function heldMessage(ms: number): FakeMessage {
  return {
    id: '18c2f4a9b3d21e10',
    threadId: T_HOLD,
    internalDateMs: ms,
    headers: { From: 'Dana Example <dana@example.com>', To: 'a@example.com', Subject: 'Contract question' },
    labelIds: ['INBOX'],
    body: 'Could you confirm the contract terms?',
  };
}

async function openLoopRows(): Promise<Array<{ dedup_key: string; loop_type: string; status: string }>> {
  return engine.executeRaw<{ dedup_key: string; loop_type: string; status: string }>(
    `SELECT dedup_key, loop_type, status FROM open_loops WHERE source_id = 'gsrc' ORDER BY dedup_key`,
  );
}

/** Simulate time passing without a Gmail signal: mark the hold due NOW. */
function expireHold(dir: string, tid: string): void {
  const file = googleStateFile(dir);
  const st = JSON.parse(readFileSync(file, 'utf-8')) as { gmail_loop_holds?: Record<string, number> };
  expect(st.gmail_loop_holds?.[tid]).toBeGreaterThan(0);
  st.gmail_loop_holds![tid] = 1;
  writeFileSync(file, JSON.stringify(st), 'utf-8');
}

describe('gmail grace-hold re-evaluation (#5868)', () => {
  test('held thread re-fetches once its window lapses — no new history needed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g5868-'));
    const fx = emptyFx();
    fx.messages.push(heldMessage(hoursAgoMs(2)));
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        // Sweep 1: the inbound ask is 2h old → inside the 24h grace window →
        // detection holds, no loop opens, and the hold is PERSISTED with its
        // deadline (last message + 24h).
        await sweep(dir, fx, vault);
        expect(await openLoopRows()).toEqual([]);
        const st1 = readGoogleState(dir);
        const due1 = st1.gmail_loop_holds?.[T_HOLD];
        expect(due1).toBe(hoursAgoMs(2) + 24 * 3_600_000);

        // Time passes; Gmail never re-lists the quiet thread (empty history).
        fx.messages[0] = heldMessage(hoursAgoMs(26));
        expireHold(dir, T_HOLD);
        fx.history = [];
        const fetchesBefore = fx.threadFetches.get(T_HOLD) ?? 0;

        await sweep(dir, fx, vault);

        // The hold drain re-fetched the thread and the loop opened.
        expect(fx.threadFetches.get(T_HOLD) ?? 0).toBe(fetchesBefore + 1);
        const loops = await openLoopRows();
        expect(loops.map((l) => l.dedup_key)).toContain(`thread:${T_HOLD}:unanswered_inbound`);
        expect(readGoogleState(dir).gmail_loop_holds?.[T_HOLD]).toBeUndefined();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('not-yet-due holds are left alone; a still-unserved sweep re-records the deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g5868b-'));
    const fx = emptyFx();
    fx.messages.push(heldMessage(hoursAgoMs(2)));
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault);
        // Second sweep, hold NOT due (deadline untouched): no re-fetch.
        fx.history = [];
        const fetchesBefore = fx.threadFetches.get(T_HOLD) ?? 0;
        await sweep(dir, fx, vault);
        expect(fx.threadFetches.get(T_HOLD) ?? 0).toBe(fetchesBefore);
        expect(await openLoopRows()).toEqual([]);
        // Hold persists for its real deadline.
        expect(readGoogleState(dir).gmail_loop_holds?.[T_HOLD]).toBeGreaterThan(Date.now());
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a due hold on a vanished thread clears the ledger (404)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'g5868c-'));
    const fx = emptyFx();
    fx.messages.push(heldMessage(hoursAgoMs(2)));
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault);
        // Thread vanished upstream: the drain's fetch 404s and the ledger
        // clears instead of wedging.
        fx.goneThreads.add(T_HOLD);
        expireHold(dir, T_HOLD);
        fx.history = [];
        await sweep(dir, fx, vault);
        const st = readGoogleState(dir);
        expect(st.gmail_loop_holds?.[T_HOLD]).toBeUndefined();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
