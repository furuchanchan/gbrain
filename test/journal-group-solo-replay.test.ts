import { expect, test } from 'bun:test';
import { assertGroupMemberReplay, assertReplayIntent, intentDigest } from '../src/core/persistence/journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

/** #6075: a cursor group member replayed against a row committed on the single-page path. */
const base = { operation: 'submit_job', sourceId: 'people', slug: 'people/alice-example' };
const soloIntent = { kind: 'managed_sync_import', index: 9876, runId: 'run-1', revision: 4 };
const member = (callerIntent: Record<string, unknown>) => ({
  input: { ...base, callerIntent },
  fingerprint: intentDigest({ ...base, callerIntent }),
});
const row = (digest: string) => ({ digest }) as WriteRequest;

test('a group member adopts the row the single path admitted while the group was forming', () => {
  const prior = row(intentDigest({ ...base, callerIntent: soloIntent }));
  // The same intent group formation stamped: group on every member, after + lane under windows/lanes.
  const stamped = { ...soloIntent, group: 'head-request-id', after: 'prev-request-id', lane: 'lane-run-1' };
  expect(assertGroupMemberReplay(prior, member(stamped))).toBe(prior);
});

test('a member whose group-keyed digest matches the prior row replays directly', () => {
  const stamped = { ...soloIntent, group: 'head-request-id' };
  const item = member(stamped);
  const prior = row(item.fingerprint);
  expect(assertGroupMemberReplay(prior, item)).toBe(prior);
});

test('a member that differs past the group keys still conflicts', () => {
  const prior = row(intentDigest({ ...base, callerIntent: soloIntent }));
  const stamped = { ...soloIntent, group: 'head-request-id', revision: 5 };
  const item = member(stamped);
  expect(() => assertGroupMemberReplay(prior, item)).toThrowError(/already accepted with different intent/);
  // The pre-fix check is the observed wedge: the group digest alone conflicts with the solo row.
  expect(() => assertReplayIntent(prior, item.fingerprint)).toThrowError(/already accepted with different intent/);
});

test('the solo digest ignores only the group-formation keys', () => {
  const stamped = { ...soloIntent, group: 'g', after: 'a', lane: 'l' };
  expect(intentDigest({ ...base, callerIntent: stamped })).not.toBe(intentDigest({ ...base, callerIntent: soloIntent }));
});
