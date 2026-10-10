const REG = ['src/commands/claw-test.ts','src/commands/decide/eval-lane.ts','src/commands/decide/writepath.ts','src/core/ai/decide/answerable.ts','src/core/ai/decide/dataset.ts','src/core/ai/decide/injection.ts','src/core/ai/decide/intent.ts','src/core/ai/decide/recall-needed.ts','src/core/ai/decide/runtime.ts','src/core/ai/decide/store.ts','src/core/ai/gateway.ts','src/core/backfill-registry.ts','src/core/context/volunteer-events.ts','src/core/eval-capture.ts','src/core/facts/queue.ts','src/core/feedback/record.ts','src/core/last-retrieved.ts','src/core/persistence/service.ts','src/core/search/decide-stage.ts','src/core/search/hybrid.ts','src/core/search/telemetry.ts','src/core/trust/page-handlers.ts','src/core/trust/supersede-handlers.ts'];
const loaded = (mods: string[]) => REG.filter(r => mods.some(m => m.endsWith('/' + r)));
const run = (code: string) => { const o = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env, GBRAIN_HOME: '/nonexistent' } }); if (o.exitCode) throw new Error(o.stderr.toString()); return JSON.parse(o.stdout.toString().trim().split('\n').pop()!) as string[]; };
const full = loaded(run("await import('./src/core/operations.ts'); console.log(JSON.stringify(Object.keys(require.cache)))"));
console.log('FULL', full.join(' '));
const { OPERATION_LOADERS } = await import('./src/core/operation-loaders.generated.ts');
const missingBy = new Map<string, string[]>();
for (const name of Object.keys(OPERATION_LOADERS)) {
  const got = loaded(run(`await (await import('./src/core/operation-load.ts')).loadOperation(${JSON.stringify(name)}); console.log(JSON.stringify(Object.keys(require.cache)))`));
  const miss = full.filter(r => !got.includes(r));
  for (const m of miss) missingBy.set(m, [...(missingBy.get(m) ?? []), name]);
}
for (const [m, ops] of missingBy) console.log(m, ops.length, ops.join(','));
