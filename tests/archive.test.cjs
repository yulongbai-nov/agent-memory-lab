'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {openArchive} = require('../lib/archive.cjs');
test('atomic import, replay, revisions, checkpoint and isolation', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'archive-test-')); t.after(() => fs.rm(dir,{recursive:true,force:true}));
 const archive = await openArchive({dir});
 const base = {scope:{owner:'alice',project:'p'},source:{harness:'test',instance:'one',session:'s',coverage:{complete:false}},checkpoint:{position:'1'},items:[{id:'m',kind:'message',text:'first'}]};
 assert.equal((await archive.importBatch(base)).imported,1);
 assert.equal((await archive.importBatch(base)).replayed,true);
 const first = await archive.getItem({owner:'alice',project:'p',id:'m'});
 const next = {...base,checkpoint:{previous:'1',position:'2'},items:[{id:'m',kind:'message',text:'second'}]};
 await archive.importBatch(next);
 assert.equal((await archive.getItem({owner:'alice',project:'p',id:'m',revision:first.versionId})).item.text,'first');
 assert.equal((await archive.getItem({owner:'alice',project:'p',id:'m'})).item.text,'second');
 await assert.rejects(archive.importBatch({...next,checkpoint:{previous:'1',position:'3'}}),/Checkpoint conflict/);
 assert.equal((await archive.getCheckpoint({owner:'alice',project:'p',harness:'test',instance:'one',session:'s'})).position,'2');
 assert.equal((await archive.listSources({owner:'alice',project:'p'}))[0].source.coverage.complete,false);
 assert.deepEqual(await archive.listItems({owner:'bob',project:'p'}),[]);
 const annotation = {id:'a',scope:base.scope,kind:'note',text:'reviewed',target:{id:'m',revision:first.versionId}};
 await archive.addAnnotation(annotation); await archive.addAnnotation(annotation);
 await assert.rejects(archive.addAnnotation({...annotation,text:'changed'}),/conflict/);
 assert.equal((await archive.listAnnotations(base.scope)).length,1);
});
test('Couch push verifies existing content and rejects mismatched conflicts', async () => {
 const {pushImmutable} = require('../lib/storage-couch.cjs');
 let saved;
 const fetchImpl = async (_url,opts) => {
   if (opts?.method === 'PUT') { const doc = JSON.parse(opts.body); if (saved) return {status:409,ok:false}; saved=doc; return {status:201,ok:true}; }
   return {status:200,ok:true,json:async()=>saved};
 };
 assert.equal((await pushImmutable({url:'http://localhost:5984/test',documents:[{x:1}],fetchImpl})).pushed,1);
 assert.equal((await pushImmutable({url:'http://localhost:5984/test',documents:[{x:1}],fetchImpl})).verified,1);
 saved.payload = {x:2};
 await assert.rejects(pushImmutable({url:'http://localhost:5984/test',documents:[{x:1}],fetchImpl}),/conflict/);
 await assert.rejects(pushImmutable({url:'http://example.com/test',documents:[],fetchImpl}),/HTTPS/);
});
test('scoped two-profile exchange, replay observations, and local checkpoints', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'sync-test-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
 const a = await openArchive({dir:path.join(root,'a')}), b = await openArchive({dir:path.join(root,'b')});
 const source = {harness:'h',instance:'i',session:'s',coverage:{complete:false}};
 const batch = {scope:{owner:'o',project:'p'},source,checkpoint:{position:1},items:[{id:'1',kind:'message',text:'hello',observedAt:'first'}]};
 await a.importBatch(batch);
 await a.importBatch({...batch,source:{...source,coverage:{complete:true}},checkpoint:{previous:1,position:2},items:[{...batch.items[0],observedAt:'second'}]});
 assert.equal((await a.listItems(batch.scope)).length,1);
 const docs = new Map();
 const fetchImpl = async (url,opts={}) => {
   const u = new URL(url);
   if (u.pathname.endsWith('/_all_docs')) { const rows = [...docs.values()].sort((x,y)=>x._id.localeCompare(y._id)).map(doc=>({id:doc._id,doc})); return {status:200,ok:true,json:async()=>({rows})}; }
   const id = decodeURIComponent(u.pathname.split('/').at(-1));
   if (opts.method === 'PUT') { if (docs.has(id)) return {status:409,ok:false}; docs.set(id,JSON.parse(opts.body)); return {status:201,ok:true}; }
   return {status:200,ok:true,json:async()=>docs.get(id)};
 };
 const config = {owner:'o',project:'p',url:'http://localhost:5984/archive',fetchImpl};
 await a.sync(config); assert.equal((await b.sync(config)).pulled,1);
 assert.equal((await b.getItem({owner:'o',project:'p',id:'1'})).item.text,'hello');
 const target = {id:'1',revision:(await b.getItem({owner:'o',project:'p',id:'1'})).versionId};
 await b.addAnnotation({scope:batch.scope,id:'decision',kind:'decision',text:'A',target});
 await b.addAnnotation({scope:batch.scope,id:'change',kind:'change',text:'B',target,revises:'decision'});
 await b.sync(config); assert.equal((await a.sync(config)).pulled,2);
 assert.equal((await a.listAnnotations(batch.scope)).length,2);
 assert.equal(await b.getCheckpoint({owner:'o',project:'p',harness:'h',instance:'i',session:'s'}),null);
 await assert.rejects(b.sync({...config,owner:'other'}),/outside requested scope/);
});
test('review links bind correction to exact evidence and reject invalid changes', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'archive-review-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const a=await openArchive({dir}), scope={owner:'o',project:'p'}, source={harness:'h',instance:'i',session:'s'};
 await a.importBatch({scope,source,checkpoint:{position:1},items:[{id:'a',kind:'message'},{id:'b',kind:'message'}]});
 const av=await a.getItem({...scope,id:'a'}), bv=await a.getItem({...scope,id:'b'});
 const target={id:'a',revision:av.versionId}, other={id:'b',revision:bv.versionId};
 await a.addAnnotation({scope,id:'d',kind:'decision',text:'decision',topic:'T',target});
 await assert.rejects(a.addAnnotation({scope,id:'missing',kind:'correction',text:'fix',target}),/revises/);
 await assert.rejects(a.addAnnotation({scope,id:'bad',kind:'correction',text:'fix',target:other,revises:'d'}),/evidence mismatch/);
 await assert.rejects(a.addAnnotation({scope,id:'bad',kind:'change',text:'fix',target:other,revises:'d',topic:'different'}),/topic mismatch/);
 await assert.rejects(a.addAnnotation({scope,id:'future',kind:'correction',text:'fix',target,revises:'d',valid_time:'2030-01-01T12:00:00Z'}),/effect immediately/);
 for (const [tgt,evidence] of [[target,target],[{...target,source},target],[target,{...target,source}]]) {
   await assert.rejects(a.addAnnotation({scope,id:'duplicate',kind:'correction',text:'fix',target:tgt,revises:'d',evidence}),/not independent/);
 }
 await a.addAnnotation({scope,id:'independent',kind:'correction',text:'fix',target,revises:'d',evidence:other});
 await a.addAnnotation({scope,id:'c',kind:'correction',text:'fix',target,revises:'d'});
 await a.addAnnotation({scope,id:'next',kind:'change',text:'changed',target:other,revises:'d',topic:'T'});
 await assert.rejects(a.addAnnotation({scope,id:'bad',kind:'change',text:'fix',target,revises:'c'}),/invalid/);
 await assert.rejects(a.addAnnotation({scope,id:'bad',kind:'decision',text:'fix',target,valid_time:'tomorrow'}),/valid_time/);
});

test('same-position coverage CAS rejects an older overlapping scan', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-coverage-cas-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const archive = await openArchive({dir});
  const { checkpointRevision } = require('../lib/checkpoint.cjs');
  const scope = {owner: 'synthetic', project: 'cas'};
  const source = {harness: 'test', instance: 'local', session: 'one'};
  const original = { ...source, coverage: { gaps: ['prior'] } };
  await archive.importBatch({scope, source: original, checkpoint: {position: 8}, items: []});
  const stale = await archive.getCheckpoint({...scope, ...source});
  const checkpoint = {previous: 8, previousRevision: checkpointRevision(stale), position: 8};
  await archive.importBatch({scope, source: {...source, coverage: {gaps: []}}, checkpoint, items: []});
  await assert.rejects(archive.importBatch({
    scope, source: {...source, coverage: {gaps: ['prior', 'stale']}}, checkpoint, items: []
  }), /Checkpoint revision conflict/);
  assert.deepEqual((await archive.getCheckpoint({...scope, ...source})).source.coverage.gaps, []);
});

test('sync rejects a newly received non-independent correction but permits replay of a legacy record', async t => {
 const {digest} = require('../lib/storage.cjs');
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'correction-sync-')); t.after(() => fs.rm(root,{recursive:true,force:true}));
 const dir = path.join(root,'legacy'), a = await openArchive({dir}), b = await openArchive({dir:path.join(root,'fresh')});
 const scope = {owner:'o',project:'p'}, source = {harness:'h',instance:'i',session:'s'};
 await a.importBatch({scope,source,checkpoint:{position:1},items:[{id:'m',kind:'message',text:'original'}]});
 const record = await a.getItem({...scope,id:'m'}), target = {id:'m',revision:record.versionId};
 const decision = {scope,id:'d',kind:'decision',text:'decision',target};
 await a.addAnnotation(decision);
 const legacy = {scope,id:'c',kind:'correction',text:'fix',target,revises:'d',evidence:target};
 const file = path.join(dir,'archive.json'), state = JSON.parse(await fs.readFile(file,'utf8'));
 state.annotations[JSON.stringify([scope.owner,scope.project,legacy.id])] = legacy;
 await fs.writeFile(file,JSON.stringify(state));
 const payloads = [{kind:'version',record},{kind:'annotation',record:decision},{kind:'annotation',record:legacy}];
 const docs = payloads.map(payload => ({_id:`immutable:${digest(payload)}`,type:'immutable',payload})).sort((x,y) => x._id.localeCompare(y._id));
 const fetchImpl = async (url,opts={}) => {
   if (new URL(url).pathname.endsWith('/_all_docs')) return {status:200,ok:true,json:async()=>({rows:docs.map(doc=>({id:doc._id,doc}))})};
   if (opts.method === 'PUT') return {status:201,ok:true};
   throw new Error('unexpected request');
 };
 const config = {...scope,url:'http://localhost:5984/archive',fetchImpl,mode:'pull'};
 assert.equal((await a.sync(config)).pulled,0);
 await assert.rejects(b.sync(config),/not independent/);
 assert.deepEqual(await b.listAnnotations(scope),[]);
 assert.deepEqual(await b.listItems(scope),[]);
 const duplicate = docs.find(doc => doc.payload.record.id === 'c');
 docs.push(duplicate); docs.sort((x,y) => x._id.localeCompare(y._id));
 await assert.rejects(b.sync(config),/not independent/);
 assert.deepEqual(await b.listAnnotations(scope),[]);
 assert.deepEqual(await b.listItems(scope),[]);
 assert.equal((await a.sync(config)).pulled,0);
 assert.deepEqual((await a.listAnnotations(scope)).find(row => row.id === 'c'),legacy);
});
