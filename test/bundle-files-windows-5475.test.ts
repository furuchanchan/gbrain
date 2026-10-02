/**
 * #5475: two Windows-specific publication failures remain after #5776's
 * per-segment path fix — a directory fsync fails with EPERM on win32, and
 * Windows `st_mode` synthesizes POSIX bits from the read-only flag only, so a
 * file chmod'ed 0o644 reads back 0o666 and strict mode equality rejects every
 * staged file. Both helpers take `platform` explicitly so the win32 branches
 * run on every OS.
 */

import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { bundleDirectoryFlushErrorIsBenign, bundleFileHash, bundleModesMatch } from '../src/core/persistence/bundle-files.ts';
import type { FileRecoveryRecord } from '../src/core/persistence/model.ts';
import { sha256 } from '../src/core/persistence/digest.ts';

const WIN = 'win32' as NodeJS.Platform;
const POSIX = 'linux' as NodeJS.Platform;

describe('#5475 bundleModesMatch', () => {
  test('compares exactly on POSIX', () => {
    expect(bundleModesMatch(0o644, 0o644, POSIX)).toBe(true);
    expect(bundleModesMatch(0o644, 0o600, POSIX)).toBe(false);
    expect(bundleModesMatch(0o644, 0o666, POSIX)).toBe(false);
  });

  test('on win32 only the writable-vs-read-only distinction is real', () => {
    // The issue's case: chmod 0o644 reads back 0o666 on Windows.
    expect(bundleModesMatch(0o644, 0o666, WIN)).toBe(true);
    expect(bundleModesMatch(0o600, 0o666, WIN)).toBe(true);
    // A private-mode expectation must not match a read-only file.
    expect(bundleModesMatch(0o644, 0o444, WIN)).toBe(false);
    expect(bundleModesMatch(0o444, 0o666, WIN)).toBe(false);
    expect(bundleModesMatch(0o444, 0o444, WIN)).toBe(true);
  });
});

describe('#5475 bundleDirectoryFlushErrorIsBenign', () => {
  test('the dir-fsync error set is benign only on win32', () => {
    for (const code of ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']) {
      expect(bundleDirectoryFlushErrorIsBenign(code, WIN)).toBe(true);
      expect(bundleDirectoryFlushErrorIsBenign(code, POSIX)).toBe(false);
    }
    expect(bundleDirectoryFlushErrorIsBenign('EIO', WIN)).toBe(false);
    expect(bundleDirectoryFlushErrorIsBenign('', WIN)).toBe(false);
  });
});

describe('#5475 bundleFileHash mode check', () => {
  test('a file whose real mode drifted is still refused, and the win32-tolerant check is plumbed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-5475-')));
    try {
      const path = join(root, 'skill.md');
      const body = Buffer.from('skill body');
      writeFileSync(path, body);
      chmodSync(path, 0o666); // what the same file reads as on Windows after chmod 0o644
      const record: FileRecoveryRecord = {
        version: 1, path, root,
        before: body.toString('base64'), beforeHash: sha256(body), afterHash: null,
        mode: 0o644, ownerEpoch: 'epoch', attempt: 'attempt',
      };
      // POSIX: the synthesized-mode drift the issue describes is a real drift —
      // strict equality still refuses outside win32.
      let code = '';
      try { bundleFileHash(record); } catch (e) { code = (e as { code?: string }).code ?? ''; }
      if (process.platform === 'win32') {
        expect(code).toBe('');
        expect(bundleFileHash(record)).toBe(sha256(body));
      } else {
        expect(code).toBe('unexpected_file_bytes');
        // The production call site honors a forced win32 platform too — the
        // same file that refuses on POSIX reads under win32 semantics.
        const original = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
        try { expect(bundleFileHash(record)).toBe(sha256(body)); }
        finally { Object.defineProperty(process, 'platform', original); }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
