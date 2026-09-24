/**
 * google-source attachment metadata (#5350) — email thread pages carried no
 * attachment information at all, not even filenames, so "the invoice Dana
 * sent" was unsearchable and the page's incompleteness was invisible.
 *
 * The fix enumerates non-inline MIME parts carrying a filename per message
 * (metadata only — bytes are never fetched) and emits them per message plus
 * as a thread-level frontmatter list.
 *
 * Harness mirrors test/google-source-materialize.test.ts (real PGLite +
 * mutable fake behind fetchImpl + in-memory vault).
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
import { extractAttachments } from '../src/core/google/google-clients.ts';
import {
  parseGoogleSourceConfig,
  runGoogleSync,
} from '../src/core/google/google-source.ts';
import { renderThreadPage } from '../src/core/google/google-render.ts';
import type { GmailThreadData } from '../src/core/google/types.ts';

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

// ── extractAttachments (unit) ────────────────────────────────────────────────

describe('extractAttachments', () => {
  test('non-inline filename parts are captured; inline and unnamed parts are not', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: 'aGk', size: 2 } },
            { mimeType: 'text/html', body: { data: 'PGI+aGk8L2I+', size: 11 } },
            {
              mimeType: 'image/png',
              filename: 'logo.png',
              headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }],
              body: { size: 800, attachmentId: 'att2' },
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
          body: { size: 20480, attachmentId: 'att1' },
        },
        {
          // No Content-Disposition header — Gmail still calls it an attachment.
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: 'figures.xlsx',
          body: { size: 5120, attachmentId: 'att3' },
        },
      ],
    };

    const out = extractAttachments(payload);
    expect(out).toEqual([
      { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 20480 },
      {
        filename: 'figures.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 5120,
      },
    ]);
  });
});

// ── renderThreadPage emission (unit) ─────────────────────────────────────────

function msg(over: Partial<GmailThreadData['messages'][0]>): GmailThreadData['messages'][0] {
  return {
    id: '18c2f4a9b3d21e09',
    threadId: '18c2f4a9b3d21e08',
    from: 'Dana Example <dana@example.com>',
    fromAddress: 'dana@example.com',
    to: ['a@example.com'],
    cc: [],
    subject: 'Q3 invoice',
    dateIso: '2026-08-20T10:00:00.000Z',
    internalDateMs: Date.parse('2026-08-20T10:00:00.000Z'),
    labelIds: ['INBOX'],
    listUnsubscribe: false,
    bodyText: 'Attached is the Q3 invoice.',
    attachments: [],
    ...over,
  };
}

describe('renderThreadPage attachment emission', () => {
  test('frontmatter carries the thread-level filename list and each message lists its attachments', () => {
    const thread: GmailThreadData = {
      threadId: '18c2f4a9b3d21e08',
      account: 'a@example.com',
      messages: [
        msg({
          attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 20480 }],
        }),
        msg({
          id: '18c2f4a9b3d21e0a',
          from: 'A User <a@example.com>',
          fromAddress: 'a@example.com',
          labelIds: ['SENT'],
          internalDateMs: Date.parse('2026-08-20T11:00:00.000Z'),
          dateIso: '2026-08-20T11:00:00.000Z',
          bodyText: 'Thanks, and here are the figures.',
          attachments: [
            { filename: 'figures.xlsx', mimeType: 'application/vnd.ms-excel', size: 5120 },
          ],
        }),
      ],
    };

    const rendered = renderThreadPage(thread);
    expect(rendered).not.toBeNull();
    const md = rendered!.markdown;
    expect(md).toContain('attachments: \n  - "figures.xlsx"\n  - "invoice.pdf"');
    expect(md).toContain('Attachment: invoice.pdf (application/pdf · 20 KB)');
    expect(md).toContain('Attachment: figures.xlsx (application/vnd.ms-excel · 5 KB)');
  });
});

// ── End-to-end sweep ─────────────────────────────────────────────────────────

interface FakeGoogle {
  messages: Array<{
    id: string;
    threadId: string;
    internalDateMs: number;
    labelIds: string[];
    headers: Record<string, string>;
    body: string;
    extraParts?: unknown[];
  }>;
  history: string[][];
}

function emptyFx(): FakeGoogle {
  return { messages: [], history: [] };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildFetch(fx: FakeGoogle): FetchImpl {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname === 'oauth2.googleapis.com') {
      return json({ access_token: 't2', expires_in: 3600 });
    }
    if (u.pathname.endsWith('/users/me/profile')) {
      return json({ emailAddress: 'a@example.com', historyId: '1000' });
    }
    if (u.pathname.endsWith('/users/me/messages')) {
      return json({ messages: fx.messages.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    if (u.pathname.endsWith('/users/me/history')) {
      return json({ historyId: '1000', history: fx.history.map((tids) => ({ messages: tids.map((tid) => ({ threadId: tid })) })) });
    }
    const threadMatch = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (threadMatch) {
      const tid = threadMatch[1];
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
            mimeType: 'multipart/mixed',
            headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
            parts: [
              { mimeType: 'text/plain', body: { data: b64url(m.body) } },
              ...(m.extraParts ?? []),
            ],
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

async function insertGoogleSource(dir: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    [
      'gsrc',
      'google',
      dir,
      JSON.stringify({ kind: 'google', g_account: 'a@example.com', g_services: 'gmail', g_dir: dir }),
    ],
  );
}

function cfgFor(dir: string) {
  return parseGoogleSourceConfig(
    { kind: 'google', g_account: 'a@example.com', g_services: 'gmail', g_dir: dir },
    dir,
  );
}

async function sweep(dir: string, fx: FakeGoogle, vault: FakeVault, opts: Partial<SyncOpts> = {}) {
  return runGoogleSync(
    engine,
    'gsrc',
    cfgFor(dir),
    { sourceId: 'gsrc', noEmbed: true, noExtract: true, ...opts },
    buildFetch(fx),
    vault,
  );
}

describe('google-source attachment metadata end-to-end (#5350)', () => {
  test('a swept thread page names its attachments in frontmatter and per message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-attach-'));
    const vault = makeVault();
    const fx = emptyFx();
    const nowMs = Date.now();
    fx.messages.push({
      id: '18c2f4a9b3d21e11',
      threadId: '18c2f4a9b3d21e10',
      internalDateMs: nowMs - 60_000,
      labelIds: ['INBOX'],
      headers: {
        From: 'Dana Example <dana@example.com>',
        To: 'a@example.com',
        Subject: 'Q3 invoice',
        Date: new Date(nowMs - 60_000).toUTCString(),
      },
      body: 'Attached is the Q3 invoice for review.',
      extraParts: [
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
          body: { size: 20480, attachmentId: 'att1' },
        },
        {
          mimeType: 'image/png',
          filename: 'sig-logo.png',
          headers: [{ name: 'Content-Disposition', value: 'inline; filename="sig-logo.png"' }],
          body: { size: 900, attachmentId: 'att2' },
        },
      ],
    });
    await insertGoogleSource(dir);

    try {
      await sweep(dir, fx, vault);
      const emailsDir = join(dir, 'emails');
      const found: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.md')) found.push(p);
        }
      };
      walk(emailsDir);
      expect(found.length).toBe(1);
      const md = readFileSync(found[0], 'utf-8');
      expect(md).toContain('attachments: \n  - "invoice.pdf"');
      expect(md).toContain('Attachment: invoice.pdf (application/pdf · 20 KB)');
      // Inline signature furniture is not listed as an attachment.
      expect(md).not.toContain('sig-logo.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
