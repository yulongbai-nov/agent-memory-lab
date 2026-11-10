'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs/promises'); const os = require('node:os'); const path = require('node:path');
const {openArchive} = require('../lib/archive.cjs'); const {createQuery,label} = require('../lib/query.cjs');
test('scoped structured timeline, reviewed labels, exact citations and annotation', async t => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'memory-query-')); t.after(() => fs.rm(dir,{recursive:true,force:true})); const archive = await openArchive({dir});
 const scope = {owner:'alice',project:'one'}, source={harness:'synthetic',instance:'test',session:'s'};
 const items=[{id:'1',kind:'message',timestamp:'2026-01-01',text:'raw decision',metadata:{topic:'Plan',kind:'decision',basis:'confirmed'}},{id:'2',kind:'message',timestamp:'2026-01-02',text:'approved',metadata:{topic:'Plan',kind:'decision',basis:'confirmed',reviewed:true}},{id:'3',kind:'message',timestamp:'2026-01-03',text:'changed',metadata:{topic:'Plan',kind:'change',basis:'confirmed',reviewed:true,revises:['2']}},{id:'4',kind:'message',timestamp:'2026-01-04',text:'do work',metadata:{topic:'Plan',kind:'todo',reviewed:true,next_step:'ship'}}];
 await archive.importBatch({scope,source,checkpoint:{position:1},items}); await archive.importBatch({scope:{owner:'bob',project:'one'},source,checkpoint:{position:1},items:[{id:'secret',kind:'message',text:'secret'}]});
 const q=createQuery(archive); assert.equal((await q.find({...scope})).topics[0].count,4); const rows=await q.timeline({...scope,topic:'Plan'}); assert.equal(rows[0].label,null); assert.equal(rows[0].kind,'source'); assert.equal(rows[0].text,''); assert.equal(rows[1].label,'已确定'); assert.equal(rows[2].kind,'change'); assert.equal(rows[3].next_step,'ship'); assert.equal((await q.evidence({...scope,...rows[1].citation})).text,'approved');
 await assert.rejects(q.evidence({owner:'bob',project:'one',...rows[1].citation})); await assert.rejects(q.evidence({...scope,id:'2'}));
 await q.annotate({...scope,id:'a',kind:'annotation',text:'misread',target:rows[1].citation}); assert.equal((await q.annotations(scope))[0].kind,'annotation'); assert.equal((await q.timeline(scope))[1].text,'approved');
 assert.deepEqual(['cancelled','superseded','active','active','active'].map((l,i)=>label({reviewed:true,kind:'decision',lifecycle:l,basis:['confirmed','confirmed','confirmed','proposed','uncertain'][i]})),['已取消','已替代','已确定','待决定','待核实']);
});
test('current projection follows explicit changes, corrections and flags concurrent alternatives', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-current-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const archive=await openArchive({dir}); const scope={owner:'a',project:'p'}, source={harness:'h',instance:'i',session:'s'};
 const decision=(id,text,kind='decision',revises=[])=>({id,kind:'message',text,metadata:{topic:'T',kind,reviewed:true,basis:'confirmed',revises}});
 await archive.importBatch({scope,source,checkpoint:{position:1},items:[decision('d','original')]}); const q=createQuery(archive); let current=(await q.current(scope))[0]; assert.equal(current.text,'original');
 await archive.importBatch({scope,source,checkpoint:{previous:1,position:2},items:[decision('new','new decision','change',['d'])]}); current=(await q.current(scope))[0]; assert.equal(current.text,'new decision'); assert.equal(current.kind,'change'); assert.equal((await q.timeline(scope)).length,2);
 await archive.importBatch({scope,source,checkpoint:{previous:2,position:3},items:[decision('branch','another change','change',['d'])]}); assert.equal((await q.current(scope))[0].label,'待核实');
});
test('explicit reviews over raw evidence update current state and preserve source', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-review-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const archive=await openArchive({dir}); const scope={owner:'a',project:'p'}, source={harness:'h',instance:'i',session:'s'};
 await archive.importBatch({scope,source,checkpoint:{position:1},items:[{id:'raw',kind:'message',text:'source text'}]}); const q=createQuery(archive); const citation=(await q.timeline(scope))[0].citation;
 await q.annotate({...scope,id:'decision-review',kind:'decision',text:'Use A',target:citation}); let current=(await q.current(scope))[0]; assert.equal(current.text,'Use A'); assert.equal(current.review_id,'decision-review');
 await q.annotate({...scope,id:'todo-review',kind:'todo',text:'Implement A',target:citation}); assert.equal((await q.timeline(scope)).find(x=>x.kind==='todo').next_step,'Implement A');
 await q.annotate({...scope,id:'change-review',kind:'change',text:'Use B',target:citation,revises:'decision-review'}); current=(await q.current(scope))[0]; assert.equal(current.text,'Use B'); assert.equal(current.kind,'change'); assert.equal((await q.evidence({...scope,...citation})).text,'source text');
});
test('pending and future changes do not replace confirmed decisions; correction can target review', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-pending-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const archive=await openArchive({dir}); const scope={owner:'a',project:'p'}, source={harness:'h',instance:'i',session:'s'};
 await archive.importBatch({scope,source,checkpoint:{position:1},items:[{id:'raw',kind:'message',text:'source'}, {id:'future',kind:'message',valid_time:'2099-01-01T00:00:00Z',text:'future',metadata:{topic:'h / i / s',kind:'change',basis:'confirmed',reviewed:true,revises:['base']}}]}); const q=createQuery(archive); const target=(await q.timeline(scope)).find(r=>r.citation.id==='raw').citation;
 await q.annotate({...scope,id:'base',kind:'decision',text:'A',target}); await q.annotate({...scope,id:'proposal',kind:'change',text:'B',target,revises:'base',basis:'proposed'});
 let current=(await q.current({...scope,asOf:'2026-01-01T00:00:00Z'}))[0]; assert.equal(current.text,'A'); assert.equal(current.pending[0].text,'B');
 await q.annotate({...scope,id:'fix',kind:'correction',text:'A corrected',target,revises:'base'}); current=(await q.current({...scope,asOf:'2026-01-01T00:00:00Z'}))[0]; assert.equal(current.text,'A corrected');
});
