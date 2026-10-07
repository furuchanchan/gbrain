import { expect, test } from 'bun:test';
import { requestError } from '../src/core/persistence/coordinator.ts';
import { publicFailureDetail, type PublicationFailureDetail } from '../src/core/persistence/publication-failure.ts';

/** #6075: the codeless storage_error path keeps the original error as an owner-only cause. */

test('a codeless Error keeps its name and message on the failure detail', () => {
  const failure = requestError(new TypeError('line ending normalization rejected the buffer'));
  expect(failure.code).toBe('storage_error');
  expect(failure.message).toContain('Inspect owner diagnostics.');
  expect(failure.detail as PublicationFailureDetail).toMatchObject({ origin: 'unexpected', cause: { name: 'TypeError', message: 'line ending normalization rejected the buffer' } });
});

test('a thrown non-Error object keeps bounded JSON as the cause message', () => {
  const failure = requestError({ lineEndingOnly: true, offset: 42 });
  expect((failure.detail as PublicationFailureDetail | undefined)?.cause).toMatchObject({ name: 'object', message: '{"lineEndingOnly":true,"offset":42}' });
});

test('a thrown string keeps its text; nothing persists for null/undefined throws', () => {
  expect((requestError('disk blew up').detail as PublicationFailureDetail | undefined)?.cause?.message).toBe('disk blew up');
  expect(requestError(null).detail).toBeUndefined();
});

test('the cause message stays bounded', () => {
  const failure = requestError(new Error('x'.repeat(2000)));
  expect((failure.detail as PublicationFailureDetail | undefined)?.cause?.message.length).toBe(401);
});

test('the public receipt strips the owner-only cause', () => {
  const failure = requestError(new TypeError('paths may name private sources'));
  const receipt = publicFailureDetail(failure.detail);
  expect(receipt).toMatchObject({ origin: 'unexpected' });
  expect(receipt).not.toHaveProperty('cause');
});

test('a coded unknown error keeps its code in the message and still carries the cause', () => {
  const failure = requestError(Object.assign(new Error('fs refused'), { code: 'E_WEIRD' }));
  expect(failure.message).toBe('Publication failed (E_WEIRD). Inspect owner diagnostics.');
  expect((failure.detail as PublicationFailureDetail | undefined)?.cause?.message).toBe('fs refused');
});
