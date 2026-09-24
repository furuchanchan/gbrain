/**
 * google-source gmail backfill concurrency (#5351) — the initial backfill
 * walked every thread strictly serially, so wall-clock was
 * threads × per-thread-API-latency. `g_backfill_concurrency` opts into a
 * bounded worker pool over each batch; the batch stays the checkpoint unit
 * (the floor cursor still advances only once every thread has settled).
 *
 * Without the fix: max in-flight fetches is always 1 and the config key is
 * ignored. Harness mirrors test/google-source-materialize.test.ts (real
 * PGLite + mutable fake behind fetchImpl + in-memory vault).
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type {
  CredentialEntry,
  CredentialMeta,
  CredentialVault,
  ProviderClientRecord,
} from '../src/core/creds/vault.ts';
import type { FetchImpl } from '../src/core/google/google-clients.ts';
import {
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
});

// ── Fake Google API (gmail only) ─────────────────────────────────────────────

interface FakeMessage {
  id: string;
  threadId: string;
  internalDateMs: number;
  labelIds: string[];
  headers: Record<string, string>;
  body: string;
}

interface FakeGoogle {
  messages: FakeMessage[];
  history: string[][];
  /** Artificial delay inside every thread fetch (ms). */
  threadFetchDelayMs: number;
  failThreads: Set<string>;
  /** Max simultaneous in-flight thread fetches observed. */
  maxInFlight: number;
}

function emptyFx(): FakeGoogle {
  return {
    messages: [],
    history: [],
    threadFetchDelayMs: 0,
    failThreads: new Set(),
    maxInFlight: 0,
  };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildFetch(fx: FakeGoogle): FetchImpl {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let inFlight = 0;

  return async (url: string): Promise<Response> => {
    const u = new URL(url);

    if (u.hostname === 'oauth2.googleapis.com') {
      return json({ access_token: 't2', expires_in: 3600 });
    }
    if (u.pathname.endsWith('/users/me/profile')) {
      return json({ emailAddress: 'a@example.com', historyId: '1000' });
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
      return json({ historyId: '1000', history: fx.history.map((tids) => ({ messages: tids.map((tid) => ({ threadId: tid })) })) });
    }
    const threadMatch = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (threadMatch) {
      const tid = threadMatch[1];
      inFlight++;
      if (inFlight > fx.maxInFlight) fx.maxInFlight = inFlight;
      try {
        if (fx.threadFetchDelayMs > 0) await sleep(fx.threadFetchDelayMs);
        if (fx.failThreads.has(tid)) return json({ error: { code: 500, message: 'backend error' } }, 500);
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
      } finally {
        inFlight--;
      }
    }
    return json({ error: { message: `unhandled ${u.pathname}` } }, 400);
  };
}

// ── In-memory vault (mirrors google-source-materialize.test.ts) ──────────────

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
      sendas_aliases: [],
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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function insertGoogleSource(dir: string, extraConfig: Record<string, unknown> = {}): Promise<void> {
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
        g_dir: dir,
        ...extraConfig,
      }),
    ],
  );
}

function cfgFor(dir: string, extraConfig: Record<string, unknown> = {}) {
  return parseGoogleSourceConfig(
    { kind: 'google', g_account: 'a@example.com', g_services: 'gmail', g_dir: dir, ...extraConfig },
    dir,
  );
}

async function sweep(
  dir: string,
  fx: FakeGoogle,
  vault: FakeVault,
  extraConfig: Record<string, unknown> = {},
  opts: Partial<SyncOpts> = {},
) {
  return runGoogleSync(
    engine,
    'gsrc',
    cfgFor(dir, extraConfig),
    { sourceId: 'gsrc', noEmbed: true, noExtract: true, ...opts },
    buildFetch(fx),
    vault,
  );
}

function gmsg(id: string, threadId: string, ms: number): FakeMessage {
  return {
    id,
    threadId,
    internalDateMs: ms,
    labelIds: ['INBOX'],
    headers: {
      From: 'someone@example.com',
      To: 'a@example.com',
      Subject: 'thread subject',
      Date: new Date(ms).toUTCString(),
    },
    body: 'A question for you — what do you think?',
  };
}

function mkDir(): string {
  return mkdtempSync(join(tmpdir(), 'gsrc-concurrency-'));
}

/** N conversational threads, one message each, newest inside historyDays. */
function threadsFixture(fx: FakeGoogle, n: number, baseMs: number): string[] {
  const tids: string[] = [];
  for (let i = 0; i < n; i++) {
    const tid = `17aa00000000c${String(i).padStart(3, '0')}`;
    tids.push(tid);
    fx.messages.push(gmsg(`17bb00000000d${String(i).padStart(3, '0')}`, tid, baseMs - i * 1000));
  }
  return tids;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('google-source gmail backfill concurrency (#5351)', () => {
  test('g_backfill_concurrency overlaps thread fetches within a batch', async () => {
    const dir = mkDir();
    const vault = makeVault();
    const fx = emptyFx();
    fx.threadFetchDelayMs = 25;
    const nowMs = Date.now();
    threadsFixture(fx, 8, nowMs - 60_000);
    await insertGoogleSource(dir, { g_backfill_concurrency: 4 });

    try {
      await sweep(dir, fx, vault, { g_backfill_concurrency: 4 });

      expect(fx.maxInFlight).toBeGreaterThan(1);
      expect(fx.maxInFlight).toBeLessThanOrEqual(4);
      // All 8 threads imported despite the overlap.
      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND slug LIKE 'emails/%'`,
      );
      expect(rows).toHaveLength(8);
      const state = readGoogleState(dir);
      expect(state.gmail_backfill_done).toBe(true);
      expect(state.gmail_backfill_floor_ms).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('default stays serial (in-flight never exceeds 1)', async () => {
    const dir = mkDir();
    const vault = makeVault();
    const fx = emptyFx();
    fx.threadFetchDelayMs = 15;
    const nowMs = Date.now();
    threadsFixture(fx, 6, nowMs - 60_000);
    await insertGoogleSource(dir);

    try {
      await sweep(dir, fx, vault);
      expect(fx.maxInFlight).toBe(1);
      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND slug LIKE 'emails/%'`,
      );
      expect(rows).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed thread still fails the batch under concurrency — floor does not skip past it', async () => {
    const dir = mkDir();
    const vault = makeVault();
    const fx = emptyFx();
    fx.threadFetchDelayMs = 10;
    const nowMs = Date.now();
    const tids = threadsFixture(fx, 6, nowMs - 60_000);
    fx.failThreads.add(tids[1]);
    await insertGoogleSource(dir, { g_backfill_concurrency: 3 });

    try {
      await sweep(dir, fx, vault, { g_backfill_concurrency: 3 });

      let state = readGoogleState(dir);
      expect(state.gmail_backfill_done).toBe(false);
      // The failed thread is recorded once toward poison, not once per worker.
      expect(state.gmail_fail_counts?.[tids[1]]).toBe(1);

      // Failure cleared → the retry re-lists from the floor and finishes.
      fx.failThreads.clear();
      await sweep(dir, fx, vault, { g_backfill_concurrency: 3 });
      state = readGoogleState(dir);
      expect(state.gmail_backfill_done).toBe(true);
      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND slug LIKE 'emails/%'`,
      );
      expect(rows).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
