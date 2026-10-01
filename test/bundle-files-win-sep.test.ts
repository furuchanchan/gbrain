import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBundleFile } from '../src/core/persistence/bundle-files.ts';

// #5776: on Windows `sep` is `\`, so a whole-rel regex rejecting `\` marked
// every nested path unsafe. The segment-level predicate is exercised directly
// here with a `\` separator so the win32 case runs on any CI host, plus the
// real readBundleFile path pins that POSIX semantics are unchanged.
const { hasUnsafeBundlePathSegment } =
  await import('../src/core/persistence/bundle-files.ts').catch(() => ({ hasUnsafeBundlePathSegment: undefined }));

test('a nested relative path separated by the Windows separator is safe (#5776)', () => {
  expect(hasUnsafeBundlePathSegment).toBeDefined();
  expect(hasUnsafeBundlePathSegment!('sub\\nested.md', '\\')).toBe(false);
  expect(hasUnsafeBundlePathSegment!('a\\b\\c.md', '\\')).toBe(false);
  // Unsafe content inside a win32 segment is still rejected.
  expect(hasUnsafeBundlePathSegment!('bad\\na:me.md', '\\')).toBe(true);
  expect(hasUnsafeBundlePathSegment!('bad\\seg/ment.md', '\\')).toBe(true);
  expect(hasUnsafeBundlePathSegment!('bad\\ctrl\x00char.md', '\\')).toBe(true);
});

test('POSIX semantics are unchanged: backslash inside a segment is still unsafe', () => {
  expect(hasUnsafeBundlePathSegment).toBeDefined();
  expect(hasUnsafeBundlePathSegment!('a\\b.md', '/')).toBe(true);
  expect(hasUnsafeBundlePathSegment!('sub/nested.md', '/')).toBe(false);
  expect(hasUnsafeBundlePathSegment!('na:me.md', '/')).toBe(true);
});

test('readBundleFile still rejects a POSIX filename containing a backslash', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-bundle-sep-')));
  try {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.md'), 'ok');
    writeFileSync(join(dir, 'a\\b.md'), 'unsafe name');
    expect(readBundleFile(join(dir, 'sub', 'nested.md'), dir)?.bytes.toString()).toBe('ok');
    expect(() => readBundleFile(join(dir, 'a\\b.md'), dir)).toThrow(/bounded regular files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
