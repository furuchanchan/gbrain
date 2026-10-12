/**
 * #6526: `oversized_pages` must read the effective content_sanity.bytes_block
 * (env > file > DB > default), same as the write gate — a DB-plane value set
 * via `gbrain config set` used to be invisible to the check, so doctor kept
 * warning at 500,000 bytes while the write gate honored 1,000,000.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { contentSanityEntry } from '../src/commands/doctor/checks/content-quality.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

function ctx(): DoctorContext {
  return { engine, args: [], progress: { heartbeat() {}, finish() {} } } as unknown as DoctorContext;
}

async function oversized(): Promise<Check> {
  const checks = await contentSanityEntry.run(ctx()) as Check[];
  const check = checks.find(c => c.name === 'oversized_pages');
  expect(check).toBeDefined();
  return check!;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // 600 KB: over the 500,000 default, under the 1,000,000 DB-plane value.
  await engine.putPage('people/oversized', {
    type: 'note', title: 'Oversized fixture',
    compiled_truth: 'x'.repeat(600_000), timeline: '', frontmatter: {},
  }, { sourceId: 'default' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('oversized_pages honors DB-plane content_sanity.bytes_block (#6526)', () => {
  test('warns at the 500,000 default', async () => {
    const check = await oversized();
    expect(check.status).toBe('warn');
    expect(check.message).toContain('500000');
  });

  test('a DB-plane value of 1,000,000 clears the warning', async () => {
    await engine.setConfig('content_sanity.bytes_block', '1000000');
    try {
      const check = await oversized();
      expect(check.status).not.toBe('warn');
      expect(check.message).not.toContain('exceed 500000');
    } finally {
      await engine.unsetConfig('content_sanity.bytes_block');
    }
  });
});
