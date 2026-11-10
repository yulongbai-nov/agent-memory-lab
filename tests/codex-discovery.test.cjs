'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {discoverCodexCombined,resolveCodexSession}=require('../lib/codex-discovery.cjs');
const {readCodex,sourceIdentity}=require('../lib/adapters');
const id='12345678-1234-4234-8234-123456789abc';
const name=`rollout-2026-11-10T10-11-12-${id}.jsonl`;
const bytes=JSON.stringify({type:'session_meta',payload:{id}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'synthetic'}]}})+'\n';
const items=async opts=>{const all=[];for await(const b of readCodex(opts))all.push(...b.items);return all;};
test('active to archive move retains session and item identities, deduplicating matching copies',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-combined-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const active=path.join(dir,'sessions'),archive=path.join(dir,'archived_sessions'),dated=path.join(active,'2026','11','10');
 await fs.mkdir(dated,{recursive:true});await fs.mkdir(archive);await fs.writeFile(path.join(dated,name),bytes);await fs.copyFile(path.join(dated,name),path.join(archive,name));
 const both=await discoverCodexCombined({activeRoot:active,archiveRoot:archive});assert.equal(both.files.length,1);assert.equal(both.duplicates,1);assert.equal(both.files[0].source,'active');
 const before=both.files[0],opts={owner:'owner',project:'project',instance:'instance'};
 const first=await items({...opts,file:before.file,session:before.session});
 await fs.unlink(path.join(dated,name));const after=(await discoverCodexCombined({activeRoot:active,archiveRoot:archive})).files[0];
 assert.equal(after.session,before.session);assert.equal(after.legacySession,name);
 const second=await items({...opts,file:after.file,session:after.session});
 assert.deepEqual(second.map(i=>i.id),first.map(i=>i.id));
 assert.deepEqual(sourceIdentity({harness:'codex',instance:opts.instance,session:before.session}),sourceIdentity({harness:'codex',instance:opts.instance,session:after.session}));
 assert.equal(await resolveCodexSession(after,async s=>s===name),name);
 assert.equal(await resolveCodexSession(after,async s=>s===before.session),before.session);
 assert.equal(await resolveCodexSession(after,async()=>false),before.session);
 await assert.rejects(resolveCodexSession(after,async()=>true),{code:'CODEX_IDENTITY_AMBIGUOUS'});
});
test('unverified headers and divergent overlapping snapshots are refused',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-conflict-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const active=path.join(dir,'sessions'),archive=path.join(dir,'archived_sessions'),dated=path.join(active,'2026','11','10');await fs.mkdir(dated,{recursive:true});await fs.mkdir(archive);
 await fs.writeFile(path.join(dated,name),bytes);await fs.writeFile(path.join(archive,name),bytes+'{}\n');
 let result=await discoverCodexCombined({activeRoot:active,archiveRoot:archive});assert.equal(result.ambiguous,1);assert.equal(result.files.length,0);
 await fs.unlink(path.join(dated,name));await fs.writeFile(path.join(archive,name),JSON.stringify({type:'session_meta',payload:{id:'wrong'}})+'\n');
 result=await discoverCodexCombined({activeRoot:active,archiveRoot:archive});assert.equal(result.unverifiable,1);assert.equal(result.files.length,0);
});

test('collector and intake resume one real checkpoint across a move',async t=>{
 const {openArchive}=require('../lib/archive.cjs');const {collectChanged}=require('../lib/collector.cjs');const {intakeDirectory}=require('../lib/intake.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-move-e2e-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const active=path.join(dir,'sessions'),archiveRoot=path.join(dir,'archived_sessions'),dated=path.join(active,'2026','11','10'),store=path.join(dir,'store');
 await fs.mkdir(dated,{recursive:true});await fs.mkdir(archiveRoot);await fs.mkdir(store,{mode:0o700});
 const file=path.join(dated,name);await fs.writeFile(file,bytes);
 const archive=await openArchive({dir:store}),scope={owner:'owner',project:'project'},op={scope,archive};
 const input={root:active,archiveRoot,source:'codex',instance:'instance','max-sessions':5};
 const ingest=async (_op,opts)=>{
  const key={...scope,...sourceIdentity({harness:'codex',instance:opts.instance,session:opts.session})};
  const checkpoint=await archive.getCheckpoint(key);let imported=0;
  for await(const batch of readCodex({...scope,file:opts.file,instance:opts.instance,session:opts.session,checkpoint,lookback:0})) imported+=(await archive.importBatch(batch)).imported;
  return {itemsImported:imported};
 };
 assert.equal((await collectChanged(op,input,ingest)).baseline,true);
 assert.equal((await intakeDirectory(op,input,ingest)).sessionsFailed,0);
 const before=await archive.listItems(scope);assert.equal(before.length,2);
 const prev=await archive.getCheckpoint({...scope,...sourceIdentity({harness:'codex',instance:'instance',session:`2026/11/10/${name}`})});assert.equal(prev.position,2);
 await fs.rename(file,path.join(archiveRoot,name));await fs.appendFile(path.join(archiveRoot,name),JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'later synthetic'}]}})+'\n');
 const result=await collectChanged(op,input,ingest);assert.equal(result.sessionsAttempted,1);assert.equal(result.sessionsFailed,0);
 const after=await archive.listItems(scope);assert.equal(after.length,3);assert(before.every(v=>after.some(w=>w.item.id===v.item.id&&w.versionId===v.versionId)));
 assert.equal((await archive.listSources(scope)).length,1);assert.equal((await archive.getCheckpoint({...scope,...sourceIdentity({harness:'codex',instance:'instance',session:`2026/11/10/${name}`})})).position,3);
 assert.equal((await intakeDirectory(op,input,ingest)).sessionsFailed,0);assert.equal((await archive.listItems(scope)).length,3);
});

test('noncanonical active entries survive while ambiguity prevents collector pruning',async t=>{
 const {collectChanged}=require('../lib/collector.cjs');const {sourceIdentity}=require('../lib/adapters');const {openArchive}=require('../lib/archive.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-incomplete-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const active=path.join(dir,'sessions'),archiveRoot=path.join(dir,'archive'),dated=path.join(active,'2026','11','10'),store=path.join(dir,'store');await fs.mkdir(dated,{recursive:true});await fs.mkdir(archiveRoot);await fs.mkdir(store,{mode:0o700});
 await fs.writeFile(path.join(active,'legacy.jsonl'),'{}\n');await fs.writeFile(path.join(dated,name),bytes);
 const archive=await openArchive({dir:store}),scope={owner:'o',project:'p'},op={scope,archive},input={root:active,archiveRoot,source:'codex',instance:'i'};
 assert.equal((await collectChanged(op,input,async()=>({itemsImported:0}))).baseline,true);
 const stateFile=path.join(store,(await fs.readdir(store)).find(x=>x.startsWith('collector-')&&x.endsWith('.json')));
 const before=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.equal(Object.keys(before.entries).length,2);
 await fs.writeFile(path.join(archiveRoot,name),bytes+'{}\n');await fs.unlink(path.join(active,'legacy.jsonl'));
 const r=await collectChanged(op,input,async()=>({itemsImported:0}));assert.equal(r.blocked,1);
 const after=JSON.parse(await fs.readFile(stateFile,'utf8'));assert.equal(Object.keys(after.entries).length,2);
 assert(sourceIdentity);
});
