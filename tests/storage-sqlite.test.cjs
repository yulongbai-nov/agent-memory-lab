'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {openArchive}=require('../lib/archive.cjs');
const {openSqlite,migrateJsonToSqlite}=require('../lib/storage-sqlite.cjs');
test('migration preserves records and scoped queries; transactions commit or roll back',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlite-archive-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={owner:'alice',project:'p'}, source={harness:'h',instance:'i',session:'s'}, archive=await openArchive({dir});
 await archive.importBatch({scope,source,checkpoint:{position:1},items:[{id:'m',kind:'message',text:'first'}]});
 const first=await archive.getItem({...scope,id:'m'});
 await archive.importBatch({scope,source,checkpoint:{previous:1,position:2},items:[{id:'m',kind:'message',text:'second'}]});
 await archive.addAnnotation({scope,id:'n',kind:'note',text:'review',target:{id:'m',revision:first.versionId}});
 const expectedItems=await archive.listItems(scope);
 const before=await fs.readFile(path.join(dir,'archive.json'));
 const result=await migrateJsonToSqlite({dir}); assert.deepEqual(result,{versions:2,checkpoints:1,batches:2,annotations:1});
 assert.deepEqual(await fs.readFile(path.join(dir,'archive.json')),before);
 const store=await openSqlite({dir}); t.after(()=>store.close());
 assert.deepEqual(store.listItems(scope),expectedItems);
 assert.equal(store.findItems(scope,'m').length,2); assert.equal(store.findVersion(scope,'m',first.versionId).item.text,'first');
 assert.equal(store.listSources(scope)[0].position,2); assert.equal(store.listAnnotations(scope).length,1);
 assert.deepEqual(store.listItems({owner:'other',project:'p'}),[]);
 await assert.rejects(store.transaction(tx=>{tx.putBatch('rollback',42);throw Error('fail');}),/fail/);
 assert.equal(store.getBatch('rollback'),null);
 await store.transaction(tx=>tx.putBatch('new',42)); assert.deepEqual(store.getBatch('new'),{position:42});
 await assert.rejects(store.transaction(tx=>tx.putBatch('new',43)),/conflict/);
 await assert.rejects(migrateJsonToSqlite({dir}),/already exists/);
 const ro=await openSqlite({dir,readOnly:true}); assert.equal(ro.listItems(scope).length,2); await assert.rejects(ro.transaction(()=>{}),/read-only/); ro.close();
});
test('failed migration never activates a partial database',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlite-bad-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'archive.json'),JSON.stringify({format:1,versions:{bad:[{}]},checkpoints:{},annotations:{},batches:{}}),{mode:0o600});
 await assert.rejects(migrateJsonToSqlite({dir}));
 await assert.rejects(fs.stat(path.join(dir,'archive.sqlite3')),{code:'ENOENT'});
});
test('SQLite applies scoped filters, annotation topic evidence, and exports post-cutover writes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlite-filter-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={owner:'o',project:'p'}, source={harness:'h',instance:'i',session:'s'}, a=await openArchive({dir});
 await a.importBatch({scope,source,checkpoint:{position:1},items:[
  {id:'a',kind:'message',text:'Straße Æther',time:'2026-01-02',metadata:{topic:'Alpha'}},
  {id:'b',kind:'message',text:'other',time:'2026-02-01',metadata:{topic:'Beta'}},
  {id:'c',kind:'message',text:'missing date',metadata:{topic:'Alpha'}}]});
 const target=await a.getItem({...scope,id:'b'});
 await a.addAnnotation({scope,id:'d',kind:'decision',text:'A decision',topic:'Alpha',target:{id:'b',revision:target.versionId}});
 await migrateJsonToSqlite({dir});
 const db=await openSqlite({dir}); t.after(()=>db.close());
 assert.deepEqual(db.listItems(scope,{from:'2026-01-01',to:'2026-01-31'}).map(v=>v.item.id),['a']);
 assert.deepEqual(db.listItems(scope,{keyword:'ÆTHER'}).map(v=>v.item.id),['a']);
 assert.deepEqual(db.listItems(scope,{topic:'Alpha'}).map(v=>v.item.id),['a','b','c']);
 assert.deepEqual(db.listItems(scope,{topic:'Alpha',keyword:'other'}).map(v=>v.item.id),['b']);
 await db.transaction(tx=>tx.putBatch('post-cutover',99));
 const {exportSqliteToJson}=require('../lib/storage-sqlite.cjs'); const result=await exportSqliteToJson({dir});
 const exported=JSON.parse(await fs.readFile(result.file,'utf8')); assert.deepEqual(exported.batches['post-cutover'],{position:99});
 assert.equal(Object.values(exported.versions).flat().length,3); assert.equal(result.annotations,1);
 await assert.rejects(exportSqliteToJson({dir}),/already exists/);
});
test('review-only and compact summaries preserve review and semantic selection',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sqlite-compact-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={owner:'o',project:'p'},source={harness:'h',instance:'i',session:'s'},archive=await openArchive({dir});
 await archive.importBatch({scope,source,checkpoint:{position:1},items:[
  {id:'raw',kind:'message',role:'user',text:'æ🙂',time:'2026-01-01'},
  {id:'other',kind:'message',role:'assistant',text:'private text'},
  {id:'reviewed',kind:'message',role:'user',text:'reviewed',metadata:{reviewed:true,kind:'decision',topic:'T'}}]});
 const raw=await archive.getItem({...scope,id:'raw'});
 await archive.addAnnotation({scope,id:'decision',kind:'decision',text:'review text',target:{id:'raw',revision:raw.versionId},topic:'T'});
 await migrateJsonToSqlite({dir}); const db=await openSqlite({dir});t.after(()=>db.close());
 assert.deepEqual(db.listItems(scope,{reviewOnly:true}).map(r=>r.item.id),['raw','reviewed']);
 const compact=db.listItems(scope,{summaries:true}); assert.equal(compact.length,3);
 assert.ok(compact.every(r=>!Object.hasOwn(r.item,'text'))); assert.equal(compact[0].source.harness,'h');
 assert.equal(db.listItems(scope,{summaries:true,keyword:'private'})[0].item.text,'private text');
 const summaries=db.listVersionSummaries(scope); assert.equal(summaries.filter(s=>s.pendingReview).length,1);
 assert.equal(summaries.find(s=>s.pendingReview).previewBytes,Buffer.byteLength('æ🙂'));
 assert.equal(db.listVersionSummaries({owner:'other',project:'p'}).length,0);
});

test('local draft pages use a fixed insertion fence without returning other scope data',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'draft-page-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const a=await openArchive({dir}), scope={owner:'o',project:'p'},other={owner:'other',project:'p'},source={harness:'dsh',instance:'i',session:'s'};
 await a.importBatch({scope,source,checkpoint:{position:1},items:[{id:'old',kind:'message',time:'2030-01-01',text:'synthetic first'}]});
 await a.importBatch({scope:other,source,checkpoint:{position:1},items:[{id:'outside',kind:'message',text:'outside scope'}]});
 await a.importBatch({scope,source,checkpoint:{previous:1,position:2},items:[{id:'late',kind:'message',time:'2000-01-01',text:'synthetic late'}]});
 await migrateJsonToSqlite({dir});const ro=await openArchive({dir,readOnly:true});const fence=await ro.localDraftFence(scope);assert.equal(fence,3);
 const first=await ro.localDraftPage(scope,0,fence,2);assert.equal(first.length,2);assert.equal(first[0].record.item.id,'old');assert.equal(first[0].record.item.text,undefined);assert.equal(first[1].record,null);assert(!JSON.stringify(first).includes('outside scope'));
 const second=await ro.localDraftPage(scope,first.at(-1).seq,fence,2);assert.equal(second[0].record.item.id,'late');
 const writer=await openArchive({dir});await writer.importBatch({scope,source,checkpoint:{previous:2,position:3},items:[{id:'new',kind:'message',text:'new'}]});writer.close?.();
 assert.deepEqual(await ro.localDraftPage(scope,second.at(-1).seq,fence,2),[]);const nextFence=await ro.localDraftFence(scope);assert.equal((await ro.localDraftPage(scope,fence,nextFence,2))[0].record.item.id,'new');
 await assert.rejects(ro.localDraftPage(scope,0,nextFence,101),/Invalid local draft page/);ro.close?.();
});
