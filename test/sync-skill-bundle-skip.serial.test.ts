/**
 * #5852 — the sync walkers skip reserved skillpack paths.
 *
 * Bug class (Mauryanx): a fresh `gbrain init --content-root <dir> --git`
 * seeds the `gbrain-memory` pack (`skills/brain-router/SKILL.md`, …,
 * `skillpack.json`) into the content root and the user commits it. The first
 * `gbrain sync` then enumerated those files; on the managed route
 * `managedImportContent` refused every one with `skill_bundle_required` and
 * the run blocked at `blocked_by_failures` — gbrain's own pack poisoned the
 * first sync. On the classic route the same files were silently imported as
 * ordinary content pages instead.
 *
 * Fix: `isReservedSkillBundlePath` (the same predicate the importer refuses
 * on) now classifies `skills/**` and `skillpack.json` at any depth as
 * `'skill-bundle'` in `classifySync` (incremental + managed discovery) and
 * rejects them in `isCollectibleForWalker` (full-sync/import route) — full
 * and incremental must agree on the exclusion set.
 *
 * Marked `.serial.test.ts` because it spawns git subprocesses, shares a
 * single PGLite engine across tests, and flips `persistence_brain.enabled`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isSyncable, unsyncableReason } from '../src/core/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-skillpack-home-'));
let engine: PGLiteEngine;
let repoPath: string;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string, message: string): string {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
function gitInit(repo: string): void {
  execSync('git init -q', { cwd: repo, stdio: 'pipe' });
}

const PACK_FILES: Record<string, string> = {
  'skills/brain-router/SKILL.md': '---\nname: brain-router\ndescription: seeded pack skill\n---\n\n# Brain Router\n',
  'skillpack.json': '{"name":"gbrain-memory","skills":["brain-router"]}\n',
  // Same reserved segment at a non-root depth — the importer refuses it too.
  'docs/skills/nested.md': '---\ntype: concept\ntitle: Nested\n---\n\nNested content.\n',
};
const FOO = '---\ntype: concept\ntitle: Foo\n---\n\nBaseline content.\n';

function seedClassic(repo: string): void {
  mkdirSync(join(repo, 'topics'), { recursive: true });
  writeFileSync(join(repo, 'topics/foo.md'), FOO);
  for (const [path, body] of Object.entries(PACK_FILES)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
}

async function managedFixture(files: Record<string, string>): Promise<{ id: string; root: string }> {
  const id = `sync-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const root = join(home, id);
  mkdirSync(root, { recursive: true });
  gitInit(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  commit(root, 'initial');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

describe('#5852 — sync skips reserved skillpack paths instead of blocking', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-skillpack-'));
    gitInit(repoPath);
    seedClassic(repoPath);
    commit(repoPath, 'initial');
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('classifySync tags reserved skillpack paths at any depth', () => {
    expect(unsyncableReason('skills/brain-router/SKILL.md')).toBe('skill-bundle');
    expect(unsyncableReason('skillpack.json')).toBe('skill-bundle');
    expect(unsyncableReason('docs/skills/nested.md')).toBe('skill-bundle');
    expect(unsyncableReason('docs/skillpack.json')).toBe('skill-bundle');
    // Bare 'skills' has no extension — unsyncable either way (the reason is
    // immaterial; it must simply never reach the importer).
    expect(unsyncableReason('skills')).not.toBeNull();
    // Controls: segment boundary is exact — 'skillset' / 'skills.md' are
    // ordinary content and must stay syncable.
    expect(isSyncable('docs/skillset/tips.md')).toBe(true);
    expect(isSyncable('skills.md')).toBe(true);
    expect(isSyncable('topics/foo.md')).toBe(true);
  });

  test('classic full sync skips the seeded pack instead of importing it as pages', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(result.status);
    expect(await engine.getPage('topics/foo')).not.toBeNull();
    // Pre-fix these were minted as ordinary content pages.
    expect(await engine.getPage('skills/brain-router/skill')).toBeNull();
    expect(await engine.getPage('docs/skills/nested')).toBeNull();
  }, 60_000);

  test('managed sync on a content root carrying the seeded pack completes without skill_bundle_required', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await managedFixture({ 'topics/foo.md': FOO, ...PACK_FILES });
    const result = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(['first_sync', 'synced']).toContain(result.status);
    expect((await engine.getPage('topics/foo', { sourceId: f.id }))?.source_path).toBe('topics/foo.md');
    expect(await engine.getPage('skills/brain-router/skill', { sourceId: f.id })).toBeNull();
    expect(await engine.getPage('docs/skills/nested', { sourceId: f.id })).toBeNull();
  }), 60_000);

  test('filesystem walker skips reserved paths on --include-gitignored (regression: basename-only classification)', async () => {
    // The FS-walk fallback classified each entry by BASENAME — a file at
    // skills/brain-router/SKILL.md was judged as 'SKILL.md' and slipped past
    // isReservedSkillBundlePath. Force the fallback with includeGitignored.
    const { collectSyncableFiles } = await import('../src/commands/import.ts');
    const files = collectSyncableFiles(repoPath, { strategy: 'markdown', includeGitignored: true });
    const rels = files.map(f => f.slice(repoPath.length + 1));
    expect(rels).toContain('topics/foo.md');
    expect(rels).not.toContain('skills/brain-router/SKILL.md');
    expect(rels).not.toContain('skillpack.json');
    expect(rels).not.toContain('docs/skills/nested.md');
  });

  test('filesystem walker skips reserved paths in a non-git directory (FS fallback route)', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'gbrain-skillpack-nongit-'));
    try {
      seedClassic(nonGit); // no git init — forces the recursive FS walk
      const { collectSyncableFiles } = await import('../src/commands/import.ts');
      const files = collectSyncableFiles(nonGit, { strategy: 'markdown' });
      const rels = files.map(f => f.slice(nonGit.length + 1));
      expect(rels).toContain('topics/foo.md');
      expect(rels).not.toContain('skills/brain-router/SKILL.md');
      expect(rels).not.toContain('skillpack.json');
      expect(rels).not.toContain('docs/skills/nested.md');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  test('filesystem walker normalizes Windows separators before the gates (regression: SYNC_SKIP_FILES basename)', async () => {
    // `path.relative()` returns `docs\README.md` on Windows; the shared
    // gates speak canonical '/' rel paths, so `SYNC_SKIP_FILES`'s basename
    // check would see `docs\README.md` (not `README.md`) and admit a nested
    // metafile the git fast path excludes. On POSIX a literal '\' in a
    // filename exercises the same code path (`relative()` output with a
    // backslash reaching the gate) — the file named `windocs\README.md`
    // normalizes to `windocs/README.md` and must be excluded as a metafile,
    // while `windocs\page.md` must still collect.
    const nonGit = mkdtempSync(join(tmpdir(), 'gbrain-skillpack-winsep-'));
    try {
      writeFileSync(join(nonGit, 'windocs\\README.md'), '# readme\n');
      writeFileSync(join(nonGit, 'windocs\\index.md'), '# index\n');
      writeFileSync(join(nonGit, 'windocs\\page.md'), '# page\n');
      const { collectSyncableFiles } = await import('../src/commands/import.ts');
      const files = collectSyncableFiles(nonGit, { strategy: 'markdown' });
      const rels = files.map(f => f.slice(nonGit.length + 1));
      expect(rels).toContain('windocs\\page.md');
      expect(rels).not.toContain('windocs\\README.md');
      expect(rels).not.toContain('windocs\\index.md');
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  test('a publisher-owned page under skills/ survives classic re-sync after its file is edited', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(first.status);

    await engine.putPage('skills/brain-router/skill', {
      type: 'skill',
      title: 'Brain Router',
      compiled_truth: 'Publisher-owned pack page.',
      timeline: '',
      frontmatter: { type: 'skill', id: 'brain-router' },
    });
    writeFileSync(join(repoPath, 'skills/brain-router/SKILL.md'), '---\nname: brain-router\ndescription: edited\n---\n\n# Brain Router v2\n');
    execSync('git add -A && git commit -qm "edit skill"', { cwd: repoPath, stdio: 'pipe' });

    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'up_to_date']).toContain(second.status);
    const survivor = await engine.getPage('skills/brain-router/skill');
    expect(survivor?.compiled_truth).toContain('Publisher-owned pack page');
  }, 60_000);
});
