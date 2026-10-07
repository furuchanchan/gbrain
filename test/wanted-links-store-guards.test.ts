// #6225/#6228 — replaceWantedLinks must not let one bad reference abort the
// whole extract run: a qualified link to an unregistered source keeps its
// wanted row without a page lock, and a target that fails slug validation is
// dropped like a missing target.
import { describe, expect, test } from 'bun:test';
import { replaceWantedLinks, type WantedLinkInput } from '../src/core/wanted-links-store.ts';
import { validateSlug } from '../src/core/utils.ts';
import type { BrainEngine } from '../src/core/engine.ts';

type LockKey = { sourceId: string; slug: string };
type StubTx = Pick<BrainEngine, 'executeRaw' | 'lockPageKeys'> & { lockCalls: LockKey[][] };

// Stub tx whose lockPageKeys mimics the real guard: it revalidates the slug
// and throws for a source that is not registered — the two throws that used
// to end an extract run inside the transaction.
function stubTx(registeredSources: string[]): StubTx {
  const lockCalls: LockKey[][] = [];
  const tx = {
    lockCalls,
    async lockPageKeys(keys: readonly LockKey[]): Promise<void> {
      for (const k of keys) {
        validateSlug(k.slug);
        if (!registeredSources.includes(k.sourceId)) {
          throw new Error(`Page source does not exist: ${k.sourceId}`);
        }
      }
      lockCalls.push(keys.map(k => ({ ...k })));
    },
    async executeRaw(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      if (sql.includes('FROM sources WHERE id = ANY')) {
        const ids = params[0] as string[];
        return ids.filter(id => registeredSources.includes(id)).map(id => ({ id }));
      }
      if (sql.includes('INSERT INTO wanted_links')) {
        const pack = params[params.length - 1] as { rows: unknown[] };
        return pack.rows.map((_, i) => ({ id: i + 1 }));
      }
      return []; // DELETE and anything else
    },
  };
  return tx as unknown as StubTx;
}

const ORIGIN = { pageId: 7, sourceId: 'src-a' };
const ROW = (target_source_id: string, target_ref: string): WantedLinkInput => ({
  producer: 'body', ref_kind: 'slug', target_source_id, target_ref,
  link_type: 'mentions', context: '',
});

describe('wanted-links store guards (#6225/#6228)', () => {
  test('a qualified link to an unregistered source keeps its row but is never locked (#6225)', async () => {
    const tx = stubTx(['src-a']);
    const written = await replaceWantedLinks(tx, ORIGIN, {
      producers: ['body'],
      rows: [ROW('memory', '12345'), ROW('src-a', 'people/missing')],
    });
    // target_source_id carries no FK: the 'memory' row stays listed so a
    // source registered later still resolves — it just has no incarnation
    // to lock against.
    expect(written).toBe(2);
    expect(tx.lockCalls).toEqual([[{ sourceId: 'src-a', slug: 'people/missing' }]]);
  });

  test('a target that fails slug validation is dropped instead of thrown (#6228)', async () => {
    const tx = stubTx(['src-a']);
    const written = await replaceWantedLinks(tx, ORIGIN, {
      producers: ['body'],
      rows: [
        ROW('src-a', '/jina\\.local/, () => json(corpo, status)'),
        ROW('src-a', 'people/missing'),
      ],
    });
    expect(written).toBe(1);
    expect(tx.lockCalls).toEqual([[{ sourceId: 'src-a', slug: 'people/missing' }]]);
  });

  test('a batch whose only targets are unreachable never locks and never throws', async () => {
    const tx = stubTx(['src-a']);
    const written = await replaceWantedLinks(tx, ORIGIN, {
      producers: ['body'],
      rows: [ROW('memory', '12345'), ROW('src-a', '/bad')],
    });
    expect(written).toBe(1); // unknown-source row kept, malformed dropped
    expect(tx.lockCalls).toEqual([]);
  });
});
