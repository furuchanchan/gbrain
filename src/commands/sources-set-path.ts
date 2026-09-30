/**
 * gbrain sources set-path <id> <path> — non-destructive local_path repair.
 *
 * Reported incident (#4739): a brain's `default` source sat with
 * `local_path: null` while the sync.repo_path fallback was broken, and there
 * was no way to fix the pointer short of a raw SQL UPDATE. Mirrors
 * runSetCrMode's shape (sources.ts): loud rejection on a missing source
 * (never a silent 0-row UPDATE), prints the prior value before changing it
 * so the change is visible/reversible, and never touches files on disk —
 * purely a DB pointer repair. Enforces the same overlapping-path guard
 * `sources add` does (a repointed source nesting inside / swallowing another
 * source's tree misattributes files on sync); `--force` bypasses it.
 *
 * `--clear` (#5673) is the one reset path: connector-managed sources can be
 * stranded with a local_path nothing owns, and a filesystem repoint is the
 * wrong repair for them — their canonical writes flow through the connector
 * binding, never the filesystem root. Clears to NULL; refused for filesystem
 * sources and while an incarnation-matched connector binding still verifies
 * against the path.
 *
 * Lives in its own module (like sources-demo.ts / sources-harden.ts) so
 * sources.ts stays under its module-size ratchet ceiling.
 */
import { existsSync, statSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { msysToNativePath } from '../core/path-confine.ts';
import type { BrainEngine } from '../core/engine.ts';
import { assertNoOverlappingPath, SourceOpError } from '../core/sources-ops.ts';

export async function runSetPath(engine: BrainEngine, rawArgs: string[]): Promise<void> {
  if (!rawArgs.includes('--help') && !rawArgs.includes('-h')) {
    const { runConnectedSourceLifecycle } = await import('./sources-lifecycle.ts');
    if (await runConnectedSourceLifecycle(engine, ['set-path', ...rawArgs])) return;
  }
  const force = rawArgs.includes('--force');
  const clear = rawArgs.includes('--clear') || rawArgs.includes('--null');
  const args = rawArgs.filter((a) => a !== '--force' && a !== '--clear' && a !== '--null');
  const id = args[0];
  const rawPath = args[1];

  // #5673: a connector-managed source (config.kind google/github) can be left
  // with a local_path nothing owned — topologies forbid editing it by hand,
  // and set-path only ever repointed to a real directory, so there was no
  // supported way back to NULL. `--clear` is that supported repair, restricted
  // to connector sources (a filesystem source's local_path is its identity and
  // can only be repointed) and refused while an incarnation-matched connector
  // binding still verifies the canonical root against it.
  if (clear) {
    if (!id || rawPath) {
      console.error('Usage: gbrain sources set-path <id> --clear');
      console.error("  Resets a connector-managed source's local_path to NULL — the supported repair");
      console.error('  for a stale connector root nothing owns. Filesystem sources can only be');
      console.error('  repointed (`set-path <id> <path>`), never cleared.');
      process.exit(2);
    }
    const connectorRows = await engine.executeRaw<{ local_path: string | null; kind: string | null; incarnation: string }>(
      `SELECT local_path, config->>'kind' AS kind, incarnation FROM sources WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (connectorRows.length === 0) {
      console.error(`Error: source "${id}" not found.`);
      console.error(`  Run 'gbrain sources list' to see registered sources.`);
      process.exit(4);
    }
    const connectorSource = connectorRows[0]!;
    if (connectorSource.kind !== 'google' && connectorSource.kind !== 'github') {
      console.error(`Error: source "${id}" is not connector-managed (kind: ${connectorSource.kind ?? 'filesystem'}).`);
      console.error("  A filesystem source's local_path is its write-through identity — repoint it");
      console.error('  with `gbrain sources set-path <id> <path>` instead of clearing it.');
      process.exit(6);
    }
    const bound = await engine.executeRaw(
      `SELECT 1 FROM persistence_source_bindings WHERE source_id = $1 AND source_incarnation = $2 LIMIT 1`,
      [id, connectorSource.incarnation],
    ).catch((err: unknown) => {
      // Only an absent bindings table means "no binding" — a non-persistence
      // install never created it (42P01 / PGLite's equivalent, same pattern
      // as ops/contract.ts's telemetry probe). Any other error (connection
      // drop, permission, syntax) must propagate: swallowing it would clear
      // a source the table would have shown as still bound.
      const msg = String((err as Error)?.message ?? err);
      if (/relation .* does not exist|no such table/i.test(msg)) {
        return [] as { '?column?': number }[];
      }
      throw err;
    });
    if (bound.length > 0) {
      console.error(`Error: source "${id}" has a connector binding for its current incarnation —`);
      console.error('  the binding verifies its canonical root against local_path. Release or repair');
      console.error('  the binding first (gbrain sources lifecycle), or repoint the path instead.');
      process.exit(7);
    }
    const clearedFrom = connectorSource.local_path;
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = $1`, [id]);
    console.log(`Cleared source "${id}" local_path (was ${clearedFrom ?? 'NULL'}).`);
    console.log('  Connector-managed sources carry no filesystem root — their canonical writes');
    console.log('  flow through the connector binding, not local_path.');
    console.log('Run `gbrain doctor` to confirm the change resolves any related warning.');
    return;
  }

  if (!id || !rawPath) {
    console.error('Usage: gbrain sources set-path <id> <path> [--force] | <id> --clear');
    console.error("  Sets the source's local_path — the on-disk directory gbrain treats as");
    console.error('  its write-through target and walks for sync/audit. Non-destructive: only');
    console.error('  updates the pointer, never touches files on disk.');
    console.error("  Refuses a path that overlaps another source's tree; --force bypasses that guard.");
    console.error('  --clear resets a connector-managed source to NULL (stale connector-root repair).');
    process.exit(2);
  }

  // Same treatment addSource applies (#3696 / gbrain#2955): absolutize a
  // relative path and normalize MSYS/Git-Bash drive spellings BEFORE the
  // existence check and the UPDATE. Storing '.' or '/c/Users/x' verbatim
  // would plant the exact phantom-path class this repair command exists to
  // fix (a daemon at cwd=/ join-resolves a path that does not exist).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- set-path is a trusted local CLI repair command (CLI_ONLY); absolutizing the operator's own directory is the #3696 fix
  const path = resolvePath(msysToNativePath(rawPath));

  const existing = await engine.executeRaw<{ id: string; local_path: string | null }>(
    `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (existing.length === 0) {
    console.error(`Error: source "${id}" not found.`);
    console.error(`  Run 'gbrain sources list' to see registered sources.`);
    process.exit(4);
  }

  const priorPath = existing[0]!.local_path;

  if (!existsSync(path) || !statSync(path).isDirectory()) {
    console.error(`Error: path does not exist on disk (or is not a directory): ${path}`);
    console.error('  This command only repairs the DB pointer — it never creates directories.');
    console.error('  Create the directory first, then re-run.');
    process.exit(5);
  }

  if (!force) {
    try {
      await assertNoOverlappingPath(engine, id, path);
    } catch (e) {
      if (e instanceof SourceOpError && e.code === 'overlapping_path') {
        console.error(`Error (${e.code}): ${e.message}`);
        console.error('  Pass --force to set it anyway (only if the trees are meant to overlap).');
        process.exit(6);
      }
      throw e;
    }
  }

  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, [path, id]);

  if (priorPath) {
    console.log(`Updated source "${id}" local_path: ${priorPath} -> ${path}`);
  } else {
    console.log(`Set source "${id}" local_path (was NULL) -> ${path}`);
  }
  console.log('Run `gbrain doctor` to confirm the change resolves any related warning.');
}
