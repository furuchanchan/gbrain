/**
 * #5867 — managed brain: an autopilot-shaped connector sync (noExtract: true,
 * the shape every autopilot `sync` job submits) must still enqueue
 * `loops_extract` for eligible threads. The v0.54.1.0 guard skipped the
 * enqueue whenever a managed sync carried noExtract — a leftover from when
 * the managed loops_extract writer was refused; v0.60.11.0 moved it onto the
 * coordinator, leaving the guard with nothing to protect.
 *
 * Serial: the chat-provider gate (gateway's process-global config) is the
 * shared seam; run one file per process.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, withGoogleAccount } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(async () => { resetGateway(); await teardown(); });

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const TID = '17aa00000000c586';
const NOW_MS = Date.now();

test('managed gmail sync with noExtract still enqueues loops_extract for an eligible thread', async () => withEnv(env, async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '1000';
    let flagged: string[] = [];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] });
      if (u.pathname.endsWith('/users/me/history')) {
        const records = u.searchParams.get('startHistoryId') === historyId ? [] : [{ messages: flagged.map((threadId) => ({ threadId })) }];
        return json({ historyId, history: records });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        return json({ id: m[1], messages: [{ id: '18c2f4a9b3d25867', threadId: m[1], labelIds: ['INBOX'], internalDate: String(NOW_MS),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
            { name: 'To', value: cfg.account }, { name: 'Subject', value: 'Friday plan' }], body: { data: b64url('Can you send the deck by Friday?') } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const run = () => runGoogleSync(engine, f.id, cfg, { ...options }, withGoogleAccount(fetcher, cfg.account));

    await run(); // anchor the history cursor at 1000
    historyId = '1010';
    flagged = [TID];
    const result = await run();
    expect(result.status).not.toBe('partial');

    const jobs = await engine.executeRaw<{ idempotency_key: string; thread_id: string }>(
      "SELECT idempotency_key, data->>'threadId' AS thread_id FROM minion_jobs WHERE name='loops_extract' AND data->>'sourceId' = $1", [f.id]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].thread_id).toBe(TID);
    expect(jobs[0].idempotency_key).toEndWith(`:${NOW_MS}`);
  }
}), 120_000);

test('when extraction is disabled, the sweep skips the enqueue AND the log says so', async () => withEnv(env, async () => {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  for (const engine of engines) {
    await engine.setConfig('loops.extraction_enabled', 'false');
    const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    let historyId = '2000';
    let flagged: string[] = [];
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
      if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '2000' });
      if (u.pathname.endsWith('/users/me/messages')) return json({ messages: [] });
      if (u.pathname.endsWith('/users/me/history')) {
        const records = u.searchParams.get('startHistoryId') === historyId ? [] : [{ messages: flagged.map((threadId) => ({ threadId })) }];
        return json({ historyId, history: records });
      }
      const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
      if (m) {
        return json({ id: m[1], messages: [{ id: '18c2f4a9b3d25868', threadId: m[1], labelIds: ['INBOX'], internalDate: String(NOW_MS),
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
            { name: 'To', value: cfg.account }, { name: 'Subject', value: 'Disabled sweep' }], body: { data: b64url('Can you send the deck by Friday?') } } }] });
      }
      return json({ error: { message: 'unexpected fixture route' } }, 400);
    };
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      stderrLines.push(String(chunk));
      return origWrite(chunk as string, ...(rest as [never, never]));
    }) as typeof process.stderr.write;
    try {
      await runGoogleSync(engine, f.id, cfg, { ...options }, withGoogleAccount(fetcher, cfg.account));
      historyId = '2010';
      flagged = [TID];
      await runGoogleSync(engine, f.id, cfg, { ...options }, withGoogleAccount(fetcher, cfg.account));
    } finally {
      process.stderr.write = origWrite;
      await engine.setConfig('loops.extraction_enabled', 'true');
    }
    const jobs = await engine.executeRaw('SELECT 1 FROM minion_jobs WHERE name=$1 AND data->>$2 = $3', ['loops_extract', 'sourceId', f.id]);
    expect(jobs).toHaveLength(0);
    expect(stderrLines.join('')).toContain('loops_extract: extraction disabled');
  }
}), 120_000);
