// #5597 — `gbrain transcripts ingest <dir>` tried to parse the Claude Code
// Remote Control state files next to session .jsonl files and failed on each
// with `unknown format`: `<session-uuid>.ccr-tip.json` (one per RC session)
// and `bridge-pointer.json` (one per project dir). expandPaths now excludes
// them via isClaudeCodeRemoteControlStateFile — the .ccr-tip.json suffix is
// RC-specific so it matches in any tree; the generic bridge-pointer.json
// basename only excludes inside a `.claude` tree.
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expandPaths } from '../src/commands/transcripts.ts';
import { isClaudeCodeRemoteControlStateFile } from '../src/core/transcripts/claude-code.ts';

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-ccr-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('isClaudeCodeRemoteControlStateFile', () => {
  test('.ccr-tip.json matches in any tree; the session .jsonl does not', () => {
    expect(isClaudeCodeRemoteControlStateFile('/home/u/.claude/projects/-tmp-app/abc.ccr-tip.json')).toBe(true);
    expect(isClaudeCodeRemoteControlStateFile('/custom/claude-config/projects/x/abc.ccr-tip.json')).toBe(true);
    expect(isClaudeCodeRemoteControlStateFile('/home/u/.claude/projects/-tmp-app/abc.jsonl')).toBe(false);
    expect(isClaudeCodeRemoteControlStateFile('C:\\Users\\u\\.claude\\projects\\x\\abc.ccr-tip.json')).toBe(true);
  });
  test('bridge-pointer.json matches only inside a .claude tree', () => {
    expect(isClaudeCodeRemoteControlStateFile('/home/u/.claude/projects/-tmp-app/bridge-pointer.json')).toBe(true);
    expect(isClaudeCodeRemoteControlStateFile('/work/bridge/bridge-pointer.json')).toBe(false);
    expect(isClaudeCodeRemoteControlStateFile('/home/u/.claude/projects/-tmp-app/notes.md')).toBe(false);
  });
});

describe('expandPaths Remote Control state exclusion', () => {
  test('dir expansion keeps the session .jsonl and drops ccr-tip + bridge-pointer', async () => {
    const d = tdir();
    const proj = join(d, '.claude', 'projects', '-tmp-app');
    mkdirSync(proj, { recursive: true });
    const session = join(proj, 'abc-123.jsonl');
    writeFileSync(session, JSON.stringify({ sessionId: 's1', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
    writeFileSync(join(proj, 'abc-123.ccr-tip.json'), '{"tip":"state"}\n');
    writeFileSync(join(proj, 'bridge-pointer.json'), '{"bridge":true}\n');
    expect(await expandPaths([proj])).toEqual([session]);
  });
  test('.ccr-tip.json drops even outside a .claude tree; bridge-pointer.json survives there', async () => {
    const d = tdir();
    const dir = join(d, 'somewhere');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abc-123.ccr-tip.json'), '{"tip":"state"}\n');
    const bridge = join(dir, 'bridge-pointer.json');
    writeFileSync(bridge, '{"bridge":true}\n');
    const session = join(dir, 'abc-123.jsonl');
    writeFileSync(session, '{"type":"system","content":"x"}\n');
    expect(await expandPaths([dir])).toEqual(expect.arrayContaining([session, bridge]));
    expect((await expandPaths([dir])).some(p => p.endsWith('.ccr-tip.json'))).toBe(false);
  });
  test('an explicitly-named ccr-tip file is still dropped from expansion', async () => {
    const d = tdir();
    const proj = join(d, '.claude', 'projects', '-tmp-app');
    mkdirSync(proj, { recursive: true });
    const tip = join(proj, 'abc-123.ccr-tip.json');
    writeFileSync(tip, '{"tip":"state"}\n');
    expect(await expandPaths([tip])).toEqual([]);
  });
});
