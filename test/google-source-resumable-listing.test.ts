/**
 * google-source resumable listings (#5349) — a contacts/calendar windowed
 * sweep killed mid-listing must resume at a persisted page cursor instead of
 * restarting, the same discipline gmail's initial backfill applies with its
 * floor cursor.
 *
 * Without the fix: the listing drains entirely inside one client call, so a
 * kill banks nothing — the next run re-lists from page 1, and a collection
 * too big for one watchdog window can never finish its first sweep.
 *
 * Harness mirrors test/google-source-materialize.test.ts (real PGLite +
 * mutable fake behind fetchImpl + in-memory vault) but with MULTI-PAGE
 * contacts/calendar fixtures so the kill lands mid-listing.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});

// ── Fake Google API (paged contacts + calendar) ──────────────────────────────

interface FakeGoogle {
  contacts: unknown[];
  contactsPageSize: number;
  calendarEvents: unknown[];
  calendarPageSize: number;
  /** pageToken whose fetch returns 500 once set (simulates a killed run). */
  failOnPageToken: string | null;
  /** pageToken whose fetch returns 400 (a stale resume token). */
  stalePageTokens: Set<string>;
  calls: string[];
}

function emptyFx(): FakeGoogle {
  return {
    contacts: [],
    contactsPageSize: 2,
    calendarEvents: [],
    calendarPageSize: 2,
    failOnPageToken: null,
    stalePageTokens: new Set(),
    calls: [],
  };
}

function buildFetch(fx: FakeGoogle): FetchImpl {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    fx.calls.push(u.pathname + (u.search ? u.search : ''));

    if (u.hostname === 'oauth2.googleapis.com') {
      return json({ access_token: 't2', expires_in: 3600 });
    }

    const pageToken = u.searchParams.get('pageToken');
    if (pageToken && fx.stalePageTokens.has(pageToken)) {
      return json({ error: { code: 400, message: 'Invalid pageToken' } }, 400);
    }
    if (pageToken && pageToken === fx.failOnPageToken) {
      return json({ error: { code: 500, message: 'backend error' } }, 500);
    }

    if (u.pathname.includes('/people/me/connections')) {
      if (u.searchParams.get('syncToken')) {
        return json({ connections: [], nextSyncToken: 'ppl-sync-delta' });
      }
      const start = pageToken ? Number(pageToken.slice(1)) : 0;
      const page = fx.contacts.slice(start, start + fx.contactsPageSize);
      const next = start + fx.contactsPageSize < fx.contacts.length ? `p${start + fx.contactsPageSize}` : null;
      return json({
        connections: page,
        ...(next ? { nextPageToken: next } : { nextSyncToken: 'ppl-sync-1' }),
      });
    }

    if (/\/calendars\/[^/]+\/events/.test(u.pathname)) {
      if (u.searchParams.get('syncToken')) {
        return json({ items: [], nextSyncToken: 'cal-sync-delta' });
      }
      const start = pageToken ? Number(pageToken.slice(1)) : 0;
      const page = fx.calendarEvents.slice(start, start + fx.calendarPageSize);
      const next = start + fx.calendarPageSize < fx.calendarEvents.length ? `e${start + fx.calendarPageSize}` : null;
      return json({
        items: page,
        ...(next ? { nextPageToken: next } : { nextSyncToken: 'cal-sync-1' }),
      });
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

async function insertGoogleSource(dir: string, services: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    [
      'gsrc',
      'google',
      dir,
      JSON.stringify({ kind: 'google', g_account: 'a@example.com', g_services: services, g_dir: dir }),
    ],
  );
}

function cfgFor(dir: string, services: string) {
  return parseGoogleSourceConfig(
    { kind: 'google', g_account: 'a@example.com', g_services: services, g_dir: dir },
    dir,
  );
}

async function sweep(
  dir: string,
  fx: FakeGoogle,
  vault: FakeVault,
  services: string,
  opts: Partial<SyncOpts> = {},
) {
  return runGoogleSync(
    engine,
    'gsrc',
    cfgFor(dir, services),
    { sourceId: 'gsrc', noEmbed: true, noExtract: true, ...opts },
    buildFetch(fx),
    vault,
  );
}

function contact(i: number): unknown {
  return {
    resourceName: `people/c${i}`,
    names: [{ displayName: `Contact ${i}`, metadata: { primary: true } }],
    emailAddresses: [{ value: `contact${i}@example.com` }],
  };
}

function calEvent(i: number): unknown {
  return {
    id: `event-${i}`,
    summary: `Event ${i}`,
    start: { dateTime: '2026-03-01T10:00:00Z' },
    end: { dateTime: '2026-03-01T11:00:00Z' },
    status: 'confirmed',
  };
}

function mkDir(): string {
  return mkdtempSync(join(tmpdir(), 'gsrc-resume-'));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('google-source resumable windowed listings (#5349)', () => {
  test('contacts: a killed first sweep resumes at the persisted page cursor', async () => {
    const dir = mkDir();
    const vault = makeVault();
    const fx = emptyFx();
    fx.contacts = [contact(1), contact(2), contact(3), contact(4), contact(5)];
    await insertGoogleSource(dir, 'contacts');

    try {
      // Kill the run while fetching page 2 — the listing dies, but the first
      // page's work must be banked.
      fx.failOnPageToken = 'p2';
      await sweep(dir, fx, vault, 'contacts');

      let state = readGoogleState(dir);
      expect(state.contacts_resume_page_token).toBe('p2');
      expect(state.contacts_sync_token).toBeNull();
      const firstCallCount = fx.calls.filter((c) => c.includes('connections')).length;
      expect(firstCallCount).toBe(2); // page 1 ok, page 2 killed

      // Run 2: resumes AT 'p2' — page 1 is never re-fetched.
      fx.failOnPageToken = null;
      fx.calls = [];
      await sweep(dir, fx, vault, 'contacts');

      const connectionsCalls = fx.calls.filter((c) => c.includes('connections'));
      expect(connectionsCalls[0]).toContain('pageToken=p2');
      expect(connectionsCalls.some((c) => c.includes('pageToken=p4'))).toBe(true);

      state = readGoogleState(dir);
      expect(state.contacts_resume_page_token).toBeNull();
      expect(state.contacts_sync_token).toBe('ppl-sync-1');

      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL ORDER BY slug`,
      );
      expect(rows).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('contacts: a rejected resume token falls back to a fresh full re-list', async () => {
    const dir = mkDir();
    const vault = makeVault();
    const fx = emptyFx();
    fx.contacts = [contact(1), contact(2)];
    await insertGoogleSource(dir, 'contacts');

    try {
      // Seed a stale resume cursor — the API rejects it.
      writeFileSync(
        googleStateFile(dir),
        JSON.stringify({ ...readGoogleState(dir), contacts_resume_page_token: 'stale-tok' }),
        'utf-8',
      );
      fx.stalePageTokens.add('stale-tok');

      await sweep(dir, fx, vault, 'contacts');

      const connectionsCalls = fx.calls.filter((c) => c.includes('connections'));
      expect(connectionsCalls[0]).toContain('pageToken=stale-tok'); // tried resume
      expect(connectionsCalls[1]).not.toContain('pageToken'); // fell back fresh
      expect(readGoogleState(dir).contacts_sync_token).toBe('ppl-sync-1');
      expect(readGoogleState(dir).contacts_resume_page_token).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('calendar: a killed first sweep resumes at the persisted cursor with the original window', async () => {
    const dir = mkDir();
    const vault = makeVault();
    const fx = emptyFx();
    fx.calendarEvents = [calEvent(1), calEvent(2), calEvent(3), calEvent(4), calEvent(5)];
    await insertGoogleSource(dir, 'calendar');

    try {
      fx.failOnPageToken = 'e2';
      await sweep(dir, fx, vault, 'calendar');

      let state = readGoogleState(dir);
      expect(state.calendar_resume_page_token).toBe('e2');
      expect(state.calendar_resume_time_min_iso).toBeTruthy();
      expect(state.calendar_resume_time_max_iso).toBeTruthy();
      expect(state.calendar_sync_token).toBeNull();

      const mintedMin = state.calendar_resume_time_min_iso as string;
      const mintedMax = state.calendar_resume_time_max_iso as string;

      fx.failOnPageToken = null;
      fx.calls = [];
      await sweep(dir, fx, vault, 'calendar');

      const eventsCalls = fx.calls.filter((c) => c.includes('/events'));
      expect(eventsCalls[0]).toContain('pageToken=e2');
      // The resume re-issues the SAME window the token was minted under —
      // not the drifted windowOpts of run 2.
      const resumeUrl = new URL(`https://x${eventsCalls[0]}`);
      expect(resumeUrl.searchParams.get('timeMin')).toBe(mintedMin);
      expect(resumeUrl.searchParams.get('timeMax')).toBe(mintedMax);

      state = readGoogleState(dir);
      expect(state.calendar_resume_page_token).toBeNull();
      expect(state.calendar_sync_token).toBe('cal-sync-1');

      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND slug LIKE 'calendar/%' ORDER BY slug`,
      );
      expect(rows).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
