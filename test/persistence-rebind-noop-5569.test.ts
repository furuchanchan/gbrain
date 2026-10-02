// #5569 — `sources set-path` routed through the managed `rebind` lifecycle was
// a noop whenever the writer binding already pointed at the requested root,
// so a stale `sources.local_path` column (checkout moved before the binding
// was written) was never repaired: the noop short-circuit skipped the only
// write path that updates it, and the topology guard correctly blocks a raw
// UPDATE. The noop now requires `sources.local_path` to agree with the
// requested root; a stale column takes the real rebind path, which writes
// `local_path` and re-installs the already-identical binding.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
const databaseUrl=process.env.DATABASE_URL;
for(const flavor of ['pglite',...(databaseUrl?['postgres']:[])] as const)describe(`rebind noop repairs stale local_path (${flavor})`,()=>{
let engine:BrainEngine;
let closePostgres:(()=>Promise<void>)|undefined;
beforeAll(async()=>{
  if(flavor==='postgres'){
    const fixture=await isolatedPersistencePostgres(databaseUrl!);engine=fixture.engine;closePostgres=fixture.close;
  }else{
    engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();
  }
},120_000);
afterAll(async()=>{if(!engine)return;await disposePersistenceConsumer(engine);if(closePostgres)await closePostgres();else await engine.disconnect();});
async function fixture(run:(home:string,source:string,root:string)=>Promise<void>){
  const home=mkdtempSync(join(tmpdir(),'gbrain-rebind-'));
  try{await withEnv({GBRAIN_HOME:home,DATABASE_URL:undefined,GBRAIN_DATABASE_URL:undefined},async()=>{
    await resetPgliteState(engine as PGLiteEngine);await registerLocalWriter(engine,'cli');
    const source='rebind-source',root=join(home,'canonical');mkdirSync(root);
    writeFileSync(join(root,'example.md'),'---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)',[source,root]);
    await claimWorktree(engine,source,root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await run(home,source,root);
  });}finally{rmSync(home,{recursive:true,force:true});}
}
async function staleLocalPath(source:string,stale:string){
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1',[source,stale]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}
const readLocalPath=async(source:string)=>(await engine.executeRaw<{local_path:string|null}>('SELECT local_path FROM sources WHERE id=$1',[source]))[0].local_path;

test('rebind with a stale local_path repairs it instead of returning noop',()=>fixture(async(home,source,root)=>{
  const moved=join(home,'moved-away');
  await staleLocalPath(source,moved);
  const result=await runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:root});
  expect(result).toMatchObject({state:'committed',local_path:root});
  expect(result.noop).not.toBe(true);
  expect(await readLocalPath(source)).toBe(root);
}),60_000);

test('rebind that already agrees still returns the idempotent noop receipt',()=>fixture(async(_home,source,root)=>{
  const result=await runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:root});
  expect(result).toMatchObject({state:'committed',noop:true});
  expect(await readLocalPath(source)).toBe(root);
}),60_000);

test('the repaired rebind is idempotent — a repeat request is a true noop',()=>fixture(async(home,source,root)=>{
  await staleLocalPath(source,join(home,'moved-away'));
  await runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:root,requestId:randomUUID()});
  const again=await runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:root});
  expect(again).toMatchObject({state:'committed',noop:true});
}),60_000);

test('a real rebind still moves the binding and local_path together',()=>fixture(async(home,source,root)=>{
  const candidate=join(home,'candidate');
  mkdirSync(candidate);
  writeFileSync(join(candidate,'example.md'),'---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
  const result=await runManagedSourceLifecycle(engine,{operation:'rebind',sourceId:source,path:candidate});
  expect(result).toMatchObject({state:'committed',local_path:candidate});
  expect(result.noop).not.toBe(true);
  expect(await readLocalPath(source)).toBe(candidate);
  expect((await getWorktreeBinding(engine,source))!.local_path).toBe(candidate);
}),60_000);
});
