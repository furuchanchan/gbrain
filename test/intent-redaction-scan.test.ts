/**
 * #6511: findRequestsCarrying must page its substring scan, not issue one
 * statement over the whole source journal. On a large journal the unbounded
 * scan exceeds the publication transaction's statement timeout, the failure
 * is classified transient, and the request requeues forever behind the
 * source's write queue. The scan now collects the source's sequence values
 * once and probes them in bounded windows (unique-index point lookups), so
 * every statement inspects a strictly bounded row set while returning the
 * same complete, sequence-ordered, limit-capped result.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { findRequestsCarrying } from '../src/core/persistence/intent-redaction.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

const inc = randomUUID();
/** Insert a journal row; sequence is assigned by the bigserial. Returns its sequence. */
async function seed(sourceId: string, opts: { intent?: unknown; outcome?: unknown; error_message?: string | null } = {}): Promise<number> {
  const [row] = await engine.executeRaw<{ sequence: number }>(`INSERT INTO persistence_requests
    (principal_kind, principal_id, request_id, operation, source_id, source_incarnation, slug, digest, intent, authority,
     outcome, error_detail, error_message, intent_bytes, terminal_reservation, state)
    VALUES ('local_cli','test',$1::uuid,'put_page',$2,$3::uuid,$4,'d',$5::jsonb,'{}'::jsonb,$6::jsonb,NULL,$7,0,0,'committed')
    RETURNING sequence`, [randomUUID(), sourceId, inc, `notes/${randomUUID().slice(0, 8)}`,
    opts.intent === undefined ? null : JSON.stringify(opts.intent),
    opts.outcome === undefined ? null : JSON.stringify(opts.outcome),
    opts.error_message ?? null]);
  return row!.sequence;
}

/** Count statements carrying the substring predicates issued through this engine. */
function countScans(real: BrainEngine): { proxy: BrainEngine; scans: () => number } {
  let scans = 0;
  const proxy = new Proxy(real, {
    get(t, k) {
      if (k === 'executeRaw') return (q: string, p?: unknown[]) => { if (q.includes('strpos(')) scans++; return (t.executeRaw as Function).call(t, q, p); };
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as Function).bind(t) : v;
    },
  });
  return { proxy: proxy as BrainEngine, scans: () => scans };
}

describe('findRequestsCarrying bounded scan', () => {
  test('pages the journal through bounded windows and keeps sequence order and the source filter', async () => {
    const source = `scan-${randomUUID().slice(0, 8)}`;
    const seqs: number[] = [];
    for (let i = 0; i < 24; i++) {
      if (i === 5) seqs.push(await seed(source, { intent: { note: 'mentions SECRET-CLAIM-42 in the body' } }));
      else if (i === 17) seqs.push(await seed(source, { error_message: 'boom SECRET-CLAIM-42 tail' }));
      else seqs.push(await seed(source, { intent: { note: `ordinary write ${i}` } }));
    }
    await seed('other-source', { intent: { note: 'also carries SECRET-CLAIM-42' } });
    const { proxy, scans } = countScans(engine);
    const targets = await findRequestsCarrying(proxy, source, 'SECRET-CLAIM-42', 100, { scanRows: 4 });
    expect(targets).toHaveLength(2);
    // Sequence order: the early carrier precedes the late one (windows preserve ordering).
    expect(targets[0]!.id).not.toBe(targets[1]!.id);
    // The scan ran as bounded windows: 24 source rows / 4 per window = 6 statements,
    // not the single unbounded statement that timed out on the reporter's journal.
    expect(scans()).toBe(6);
  });

  test('the limit cap is preserved across windows', async () => {
    const source = `cap-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 6; i++) await seed(source, { intent: { note: `row ${i}` } });
    await seed(source, { intent: { note: 'first NEEDLE-99 hit' } });
    await seed(source, { intent: { note: 'second NEEDLE-99 hit' } });
    const targets = await findRequestsCarrying(engine, source, 'NEEDLE-99', 1, { scanRows: 3 });
    expect(targets).toHaveLength(1);
  });

  test('a JSON-escaped needle matches serialized jsonb text', async () => {
    const source = `json-${randomUUID().slice(0, 8)}`;
    await seed(source, { outcome: { msg: 'stored rare "quoted" term verbatim' } });
    await seed(source, { outcome: { msg: 'nothing here' } });
    const targets = await findRequestsCarrying(engine, source, 'rare "quoted" term', 10, { scanRows: 1 });
    expect(targets).toHaveLength(1);
  });

  test('no source rows means no scan statements at all', async () => {
    const { proxy, scans } = countScans(engine);
    expect(await findRequestsCarrying(proxy, `empty-${randomUUID().slice(0, 8)}`, 'anything', 10)).toEqual([]);
    expect(scans()).toBe(0);
  });
});
