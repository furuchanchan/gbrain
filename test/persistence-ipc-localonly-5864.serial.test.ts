import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { setupSharedBrainContent } from '../src/core/shared-skills/setup.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { readLocalWriter, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * #5864: the persistence IPC socket is a verified-local pipe, so a `cli`
 * lane caller must reach localOnly ops (import_skill_proposal and the
 * skill-retention admin ops) instead of bouncing off the shared
 * dispatcher's localOnly backstop as `unknown_tool`. A `stdio` lane
 * caller stays remote=true and remains refused by the op's own authority.
 */
test('cli-lane IPC dispatch reaches localOnly ops; stdio lane stays refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-ipc-localonly-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine();
      const ctx: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      try {
        await engine.setConfig('mcp.publish_skills', 'true');
        await setupSharedBrainContent(ctx, { fresh: true });
        const provider = await createPersistenceIpcProvider(engine, ctx.config);
        const cliRegistration = await registerLocalWriter(engine, 'cli');
        const request = { version: 1 as const, kind: 'operation' as const, brain_id: provider.brainId,
          params: {}, registration: cliRegistration, routing: { source: 'default', cwd: home } };

        // The op now dispatches: its own parameter validation fails with a
        // real error (invalid_params — source_id/expected_hashes required),
        // not the unknown_tool envelope the localOnly backstop produced.
        await expect(provider.dispatch({ ...request, operation: 'import_skill_proposal' as const }))
          .rejects.toMatchObject({ code: 'invalid_params' });

        // A read-scope localOnly sibling reaches its handler too —
        // get_skill_retention has no required params and returns policy
        // state rather than an error body.
        const retention = await provider.dispatch({ ...request, operation: 'get_skill_retention' as const,
          params: { source_id: 'default' } }) as Record<string, unknown>;
        expect(retention.error).toBeUndefined();

        // The stdio lane is remote=true: localSkillAdministration does not
        // cover it, so the same op is refused at the grant check (or by the
        // op's own trusted-local authority) — never published.
        const stdioRegistration = await readLocalWriter(engine, 'stdio');
        await expect(provider.dispatch({ ...request, registration: stdioRegistration,
          operation: 'import_skill_proposal' as const }))
          .rejects.toMatchObject({ code: 'permission_denied' });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 120_000);
