/**
 * #5827 — link read ops (get_links / get_backlinks / traverse_graph) widened
 * to the transport-computed federated read set for no-grant callers.
 *
 * The bug: on a multi-federated brain, a legacy bearer token with no source
 * grant resolves to the scalar routing source (usually 'default', which
 * holds no pages). `search`/`get_page` widen that scope to
 * `ctx.localFederatedSourceIds` via `federatedSearchScope`, but the link ops
 * kept the scalar — the graph looked empty while search found the same
 * pages. `linkReadScopeOpts` now applies the same widening under the same
 * guards: no OAuth grant (`allowedSources` undefined), an unqualified scalar
 * scope, and a transport-computed federated set of >1 sources.
 *
 * These tests pin WHICH callers may widen — the same matrix the issue's
 * workaround exercised — plus the #2200 single-element promotion that must
 * still apply when no federated set exists.
 */
import { describe, test, expect } from 'bun:test';
import { linkReadScopeOpts, type OperationContext } from '../src/core/operations.ts';

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: {} as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

describe('linkReadScopeOpts — #5827 federated widening for no-grant callers', () => {
  test('remote no-grant scalar widens to the transport federated set', () => {
    const ctx = ctxOf({
      sourceId: 'default',
      localFederatedSourceIds: ['default', 'business'],
    });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['default', 'business'] });
  });

  test('trusted local no-grant scalar widens the same way (CLI unqualified read)', () => {
    // `gbrain backlinks <slug>` resolving to the page-less routing source on a
    // multi-federated brain must see the same graph search does.
    const ctx = ctxOf({
      remote: false,
      sourceId: 'default',
      localFederatedSourceIds: ['default', 'business'],
    });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['default', 'business'] });
  });

  test('a federated grant is never widened — the grant set wins', () => {
    const ctx = ctxOf({
      sourceId: 'default',
      localFederatedSourceIds: ['default', 'business'],
      auth: { token: 't', clientId: 'c', scopes: [], allowedSources: ['business'] } as any,
    });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['business'] });
  });

  test('remote __all__ widens like an unqualified read (sentinel is not a grant)', () => {
    const ctx = ctxOf({
      sourceId: '__all__',
      localFederatedSourceIds: ['default', 'business'],
    });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['default', 'business'] });
  });

  test('single-entry federated set does not widen (promotes remote scalar instead)', () => {
    const ctx = ctxOf({
      sourceId: 'business',
      localFederatedSourceIds: ['business'],
    });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['business'] });
  });

  test('remote scalar with no federated set keeps the #2200 single-element promotion', () => {
    const ctx = ctxOf({ sourceId: 'business' });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['business'] });
  });

  test('local scalar with no federated set keeps the scalar cross-source view', () => {
    const ctx = ctxOf({ remote: false, sourceId: 'business' });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceId: 'business' });
  });

  test('an explicit scalar outside the federated set is not smuggled wider', () => {
    // sourceId 'private' is not in the caller's federated set — widening must
    // use the transport set verbatim, never union in the scalar.
    const ctx = ctxOf({
      sourceId: 'private',
      localFederatedSourceIds: ['default', 'business'],
    });
    expect(linkReadScopeOpts(ctx)).toEqual({ sourceIds: ['default', 'business'] });
  });
});
