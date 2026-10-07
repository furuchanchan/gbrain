/**
 * #6258 — unverified_claims false positives: quotes spanning markdown markers
 * (`**bold**`, `inline code`) failed the normalized substring check, and a
 * page's own cycle/created date was flagged as a number_not_in_source claim.
 */
import { describe, test, expect } from 'bun:test';
import {
  normForGrounding,
  groundSource,
  verifyBody,
  verifyDreamPage,
  emptyQuoteVerifyStats,
  UNVERIFIED_CLAIMS_KEY,
} from '../src/core/cycle/synthesize-verify.ts';

describe('#6258 markdown markers fold away in grounding comparison', () => {
  const transcript = 'user: We settled the reload order — 先改文件、再用正确的**会话 DBus**重载(而不是杀进程,避免它退出时覆写).';
  const src = groundSource('/t/session.txt', transcript);

  test('a quote whose source spans **bold** markers still grounds', () => {
    const r = verifyBody('Order: "先改文件、再用正确的会话 DBus 重载(而不是杀进程,避免它退出时覆写)."', [src]);
    expect(r.quotes).toBe(1);
    expect(r.quarantined).toHaveLength(0);
    expect(r.failures.quote_not_in_source).toBe(0);
  });

  test('a quote whose source spans inline `code` still grounds', () => {
    const codeSrc = groundSource('/t/code.txt', 'user: Restart it with `dbus-send --session --print-reply` after the edit, not before.');
    const r = verifyBody('Step: "restart it with dbus-send --session --print-reply after the edit"', [codeSrc]);
    expect(r.quotes).toBe(1);
    expect(r.quarantined).toHaveLength(0);
  });

  test('a quote carrying the markers itself also grounds', () => {
    const r = verifyBody('Order: "先改文件、再用正确的**会话 DBus**重载(而不是杀进程,避免它退出时覆写)."', [src]);
    expect(r.quotes).toBe(1);
    expect(r.quarantined).toHaveLength(0);
  });

  test('markers fold zero-width: abutting emphasis joins, real gaps still do not', () => {
    expect(normForGrounding('a **b** c')).toBe('a b c');
    expect(normForGrounding('先改文件、再用正确的**会话 DBus**重载')).toBe('先改文件、再用正确的会话 dbus重载');
    // A fabricated claim does not pass by coincidence — letters differ, no match.
    const r = verifyBody('Order: "先改文件、再用错误的会话 DBus 重载(而不是杀进程)."', [src]);
    expect(r.quarantined.length).toBeGreaterThan(0);
    expect(r.failures.quote_not_in_source).toBe(1);
  });
});

describe("#6258 a page's own date is exempt from the numeric-claim check", () => {
  const src = groundSource('/t/2026-09-04-session.txt', 'user: We talked through the group-chat knowledge design for an hour.');
  const stats = emptyQuoteVerifyStats();

  test('a body repeating its own dream_cycle_date produces no unverified_claims', () => {
    const page = {
      slug: 'ideas/group-chat-design-abc123',
      compiled_truth: '## Group-chat knowledge design — 2026-10-06\n\nWe talked through the group-chat knowledge design for an hour.',
      timeline: '',
      frontmatter: { dream_cycle_date: '2026-10-06', created: '2026-10-06' },
    };
    const out = verifyDreamPage(page, [src], { prior: null, checkedAt: '2026-10-06' }, stats);
    expect(out.compiled_truth).toContain('2026-10-06');
    expect(out.frontmatter[UNVERIFIED_CLAIMS_KEY]).toBeUndefined();
  });

  test('a genuinely unsourced OTHER date is still flagged beside the page date', () => {
    const page = {
      slug: 'ideas/group-chat-design-def456',
      compiled_truth: '## Group-chat knowledge design — 2026-10-06\n\nWe talked through the design. The first draft shipped 2026-11-20.',
      timeline: '',
      frontmatter: { dream_cycle_date: '2026-10-06' },
    };
    const out = verifyDreamPage(page, [src], { prior: null, checkedAt: '2026-10-06' }, emptyQuoteVerifyStats());
    const unverified = out.frontmatter[UNVERIFIED_CLAIMS_KEY] as Array<{ text: string; reason: string }>;
    expect(unverified).toHaveLength(1);
    expect(unverified[0].reason).toBe('number_not_in_source');
    expect(unverified[0].text).toContain('2026-11-20');
  });
});
