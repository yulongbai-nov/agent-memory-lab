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
 // Date-only sources have no absolute instant; retain them without a time filter.
 assert.deepEqual(db.listItems(scope,{from:'2026-01-01',to:'2026-01-31'}).map(v=>v.item.id),[]);
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

test('topic source pages preserve scope, revisions, cursor binding and append fence',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'topic-page-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={owner:'o',project:'p'},source={harness:'h',instance:'i',session:'s'},a=await openArchive({dir});
 await a.importBatch({scope,source,checkpoint:{position:1},items:Array.from({length:5},(_,i)=>({id:'item'+i,kind:'message',text:'private '+i,time:`2026-01-0${i+1}T00:00:00Z`,metadata:{topic:'T'}}))});
 const firstRecord=await a.getItem({...scope,id:'item0'});
 await a.addAnnotation({scope,id:'decision',kind:'decision',text:'reviewed',topic:'T',target:{id:firstRecord.item.id,revision:firstRecord.versionId,source}});
 const {createQuery}=require('../lib/query.cjs');
 for (const backend of ['json','sqlite']) {
  if(backend==='sqlite') await migrateJsonToSqlite({dir});
  const archive=await openArchive({dir}); t.after(()=>archive.close?.()); const query=createQuery(archive);
  const first=await query.topicSources({...scope,topic:'T',limit:2}); assert.equal(first.rows.length,2);assert(first.nextCursor);assert(!JSON.stringify(first).includes('private'));
  await assert.rejects(query.topicSources({...scope,topic:'other',limit:2,cursor:first.nextCursor}),/cursor/);
  const second=await query.topicSources({...scope,topic:'T',limit:2,cursor:first.nextCursor});
  const third=await query.topicSources({...scope,topic:'T',limit:2,cursor:second.nextCursor});
  assert.equal(third.rows.length,1);assert.equal(third.nextCursor,null);
  const refs=[...first.rows,...second.rows,...third.rows].map(r=>r.citation.revision);assert.equal(new Set(refs).size,5);
  assert.deepEqual(await query.topicSources({...scope,topic:'T',from:'2026-02-01'}),{rows:[],nextCursor:null});
  const reviewed=await query.reviewedTimeline({...scope,topic:'T'});assert.deepEqual(reviewed,(await query.timeline({...scope,topic:'T'})).filter(r=>r.kind!=='source'));
  if(backend==='sqlite') {
   const {DatabaseSync}=require('node:sqlite'), inspect=new DatabaseSync(path.join(dir,'archive.sqlite3'),{readOnly:true});
   const plan=inspect.prepare('EXPLAIN QUERY PLAN SELECT seq FROM versions INDEXED BY version_scope_topic WHERE owner=? AND project=? AND topic=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all('o','p','T',0,100,3).map(r=>r.detail).join(' '); inspect.close();
   assert.match(plan,/version_scope_topic/); assert.doesNotMatch(plan,/TEMP B-TREE/);
   await archive.importBatch({scope,source,checkpoint:{previous:1,position:2},items:[{id:'new',kind:'message',text:'later',metadata:{topic:'T'}}]});
   const rest=await query.topicSources({...scope,topic:'T',limit:50,cursor:first.nextCursor});assert.equal(rest.rows.length,3);
  }
 }
});

test('reviewed pages preserve the full timeline and reject stale or rebound cursors',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reviewed-page-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={owner:'o',project:'p'},source={harness:'h',instance:'i',session:'s'},a=await openArchive({dir});
 await a.importBatch({scope,source,checkpoint:{position:1},items:[
  ...Array.from({length:23},(_,i)=>({id:'r'+i,kind:'message',text:'review '+i,time:'2026-01-01T00:00:00Z',metadata:{topic:'T',reviewed:true,kind:i%2?'todo':'decision'}})),
  {id:'unrelated',kind:'message',text:'other topic',metadata:{topic:'X'}}
 ]});
 const {createQuery}=require('../lib/query.cjs');
 for(const backend of ['json','sqlite']) {
  if(backend==='sqlite') await migrateJsonToSqlite({dir});
  const archive=await openArchive({dir}),query=createQuery(archive);t.after(()=>archive.close?.());
  const first=await query.reviewedTimelinePage({...scope,topic:'T'});assert.equal(first.rows.length,20);assert(first.nextCursor);
  if(backend==='json') {
   const priorRows=(await archive.listItems(scope)).filter(r=>r.item.metadata?.topic==='T');
   const priorInputs=[priorRows.map(r=>[r.item.id,r.versionId]),[]];
   const fingerprint=require('node:crypto').createHash('sha256').update(JSON.stringify(priorInputs)).digest('hex');
   const {binding}=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());
   const prior=Buffer.from(JSON.stringify({binding,offset:20,fingerprint})).toString('base64url');
   await assert.rejects(query.reviewedTimelinePage({...scope,topic:'T',cursor:prior}),/reviewed timeline cursor is stale/);
  }
  const unrelated=await archive.getItem({...scope,id:'unrelated'});
  await archive.addAnnotation({scope,id:'unrelated-'+backend,kind:'annotation',text:'other note',target:{id:'unrelated',revision:unrelated.versionId,source}});
  const last=await query.reviewedTimelinePage({...scope,topic:'T',cursor:first.nextCursor});assert.equal(last.rows.length,3);assert.equal(last.nextCursor,null);
  assert.deepEqual([...first.rows,...last.rows],await query.reviewedTimeline({...scope,topic:'T'}));
  await assert.rejects(query.reviewedTimelinePage({...scope,topic:'X',cursor:first.nextCursor}),/invalid reviewed timeline cursor/);
  await assert.rejects(query.reviewedTimelinePage({...scope,topic:'T',from:'2025-01-01',cursor:first.nextCursor}),/invalid reviewed timeline cursor/);
  await assert.rejects(query.reviewedTimelinePage({...scope}),/topic required/);
  await assert.rejects(query.reviewedTimelinePage({...scope,topic:'T',limit:51}),/invalid reviewed timeline limit/);
  await assert.rejects(query.reviewedTimelinePage({...scope,topic:'T',cursor:'broken'}),/invalid reviewed timeline cursor/);
  const ref=first.rows[0].citation;
  await archive.addAnnotation({scope,id:'note-'+backend,kind:'annotation',text:'new note',target:ref});
  await assert.rejects(query.reviewedTimelinePage({...scope,topic:'T',cursor:first.nextCursor}),/reviewed timeline cursor is stale/);
 }
});

test('reviewed history preserves cross-topic aliases, lineage and precise time across backends',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reviewed-alias-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={owner:'synthetic',project:'p'},other={owner:'other',project:'p'},source={harness:'dsh',instance:'i',session:'s'},outside={harness:'codex',instance:'i',session:'other'},a=await openArchive({dir});
 await a.importBatch({scope,source,checkpoint:{position:1},items:[
  {id:'root',kind:'message',text:'root',time:'2026-01-01T01:00:00.000000001+01:00',metadata:{topic:'Native'}},
  {id:'evidence',kind:'message',text:'evidence',time:'2026-01-01T00:00:00.000000002Z',metadata:{topic:'Elsewhere'}},
  {id:'legacy',kind:'message',text:'legacy',time:'2026-01-01T00:00:00.000000002Z',metadata:{topic:'Alias',reviewed:true,kind:'decision'}},
  {id:'unreviewed',kind:'message',text:'unreviewed',time:'2026-01-01T00:00:00Z',metadata:{topic:'Alias'}}]});
 await a.importBatch({scope,source:outside,checkpoint:{position:1},items:[{id:'outside',kind:'message',text:'outside',metadata:{topic:'Unrelated'}}]});
 await a.importBatch({scope:other,source,checkpoint:{position:1},items:[{id:'private',kind:'message',text:'private',metadata:{topic:'Alias',reviewed:true,kind:'decision'}}]});
 const root=await a.getItem({...scope,id:'root'}),evidence=await a.getItem({...scope,id:'evidence'}),ref=r=>({id:r.item.id,revision:r.versionId,source});
 const target=ref(root),proof=ref(evidence);
 await a.addAnnotation({scope,id:'decision',kind:'decision',topic:'Alias',text:'decision',target});
 await a.addAnnotation({scope,id:'correction',kind:'correction',text:'corrected',target,revises:'decision',evidence:proof});
 await a.addAnnotation({scope,id:'todo',kind:'todo',topic:'Alias',text:'task',target});
 await a.addAnnotation({scope,id:'completed',kind:'task-state',text:'done',taskRoot:{kind:'annotation',id:'todo'},parents:[],state:'completed',evidenceKind:'source',target,evidence:proof});
 await a.addAnnotation({scope,id:'unrelated-review',kind:'decision',topic:'Unrelated',text:'elsewhere',target:ref(evidence)});
 await a.importBatch({scope,source,checkpoint:{previous:1,position:2},items:[{id:'root',kind:'message',text:'later revision',time:'2026-01-01T00:00:00.000000003Z',metadata:{topic:'Native'}}]});
 const {createQuery}=require('../lib/query.cjs'), snapshot=async archive=>{
  const q=createQuery(archive), args={...scope,topic:'Alias'};
  const page=await q.reviewedTimelinePage({...args,limit:2});assert(page.nextCursor);const last=await q.reviewedTimelinePage({...args,limit:2,cursor:page.nextCursor});assert.equal(last.nextCursor,null);
  return {timeline:await q.reviewedTimeline(args),pages:[...page.rows,...last.rows],bounded:await q.reviewedTimeline({...args,from:'2026-01-01T00:00:00.000000002Z'}),current:await q.current(args),keywordCurrent:await q.current({...args,keyword:'root'})};
 };
 const expected=await snapshot(a);
 assert.deepEqual(expected.timeline.map(x=>x.review_id || x.text),['decision','todo','legacy']);
 assert.equal(expected.timeline.find(x=>x.review_id==='todo').task_state.state,'completed');
 assert.equal(expected.timeline.find(x=>x.review_id==='decision').annotations[0].id,'correction');
 assert.deepEqual(expected.bounded.map(x=>x.text),['legacy']);
 assert.deepEqual(expected.timeline.find(x=>x.review_id==='decision').annotations[0].evidence,proof);
 await migrateJsonToSqlite({dir});const sqlite=await openArchive({dir});t.after(()=>sqlite.close?.());
 assert.deepEqual(await snapshot(sqlite),expected);
 const store=await openSqlite({dir});t.after(()=>store.close());
 const selected=store.listItems(scope,{topic:'Alias',reviewOnly:true,reviewedTimeline:true});
 assert.deepEqual(selected.map(row=>[row.item.id,row.versionId]),[['root',root.versionId],['legacy',(await sqlite.getItem({...scope,id:'legacy'})).versionId]]);
});

test('SQLite reviewed pages fetch bounded roots and their dependencies, with relevant cursor invalidation',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'reviewed-sql-page-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const scope={owner:'synthetic',project:'p'},other={owner:'other',project:'p'},source={harness:'h',instance:'i',session:'s'},a=await openArchive({dir});
 await a.importBatch({scope,source,checkpoint:{position:1},items:[
  {id:'target',kind:'message',text:'target',time:'2026-01-01T01:00:00.000000001+01:00',metadata:{topic:'Native'}},
  {id:'proof',kind:'message',text:'proof',metadata:{topic:'Elsewhere'}},
  ...['z','é','a'].map(id=>({id,kind:'message',text:id,time:'2026-01-01T00:00:00.000000002Z',metadata:{topic:'Alias',reviewed:true,kind:'decision'}})),
  {id:'unrelated',kind:'message',text:'unrelated',metadata:{topic:'Elsewhere'}}]});
 await a.importBatch({scope:other,source,checkpoint:{position:1},items:[{id:'private',kind:'message',text:'private',metadata:{topic:'Alias',reviewed:true,kind:'decision'}}]});
 const target=await a.getItem({...scope,id:'target'}),proof=await a.getItem({...scope,id:'proof'}),unrelated=await a.getItem({...scope,id:'unrelated'});
 const ref=r=>({id:r.item.id,revision:r.versionId,source}),targetRef=ref(target),proofRef=ref(proof);
 await a.addAnnotation({scope,id:'decision',kind:'decision',text:'decision',topic:'Alias',target:targetRef,valid_time:'2026-01-01T00:00:00.000000003Z'});
 await a.addAnnotation({scope,id:'correction',kind:'correction',text:'correction',target:targetRef,revises:'decision',evidence:proofRef});
 await a.addAnnotation({scope,id:'todo',kind:'todo',text:'todo',topic:'Alias',target:targetRef});
 await a.addAnnotation({scope,id:'done',kind:'task-state',text:'done',taskRoot:{kind:'annotation',id:'todo'},parents:[],state:'completed',evidenceKind:'source',target:targetRef,evidence:proofRef});
 await a.addAnnotation({scope,id:'unrelated-review',kind:'decision',text:'other review',topic:'Elsewhere',target:ref(unrelated)});
 await migrateJsonToSqlite({dir});const archive=await openArchive({dir});t.after(()=>archive.close?.());
 const {createQuery}=require('../lib/query.cjs'),query=createQuery(archive),args={...scope,topic:'Alias'};
 const full=await query.reviewedTimeline(args);
 assert.deepEqual(full.map(r=>r.review_id || r.text),['todo','a','z','é','decision']);
 assert.deepEqual(full.at(-1).annotations[0].evidence,proofRef);
 assert.equal(full[0].task_state.state,'completed');
 const dateRange={from:'2026-01-01T00:00:00.000000001Z',to:'2026-01-01T00:00:00.000000001Z'};
 const dated=await query.reviewedTimeline({...args,...dateRange});
 assert.deepEqual(dated.map(r=>r.review_id),['todo','decision']);
 assert.equal(dated.at(-1).time,'2026-01-01T00:00:00.000000003Z');
 const calls=[],originalPage=archive.reviewedHistoryPage.bind(archive),originalItems=archive.listItems,originalAnnotations=archive.listAnnotations;
 archive.reviewedHistoryPage=async (...params)=>{const result=await originalPage(...params);calls.push({params,result});return result;};
 archive.listItems=()=>{throw Error('reviewed page must not load scope-wide items');};
 archive.listAnnotations=()=>{throw Error('reviewed page must not load scope-wide annotations');};
 const first=await query.reviewedTimelinePage({...args,limit:2});assert(first.nextCursor);assert.equal(first.rows.length,2);
 const middle=await query.reviewedTimelinePage({...args,limit:2,cursor:first.nextCursor});assert(middle.nextCursor);assert.equal(middle.rows.length,2);
 const last=await query.reviewedTimelinePage({...args,limit:2,cursor:middle.nextCursor});assert.equal(last.nextCursor,null);
 assert.deepEqual([...first.rows,...middle.rows,...last.rows],full);
 assert.equal(calls.length,3);
 assert.deepEqual(calls.map(({result})=>result.dependencies.map(a=>a.id)),[['done'],[],['correction']]);
 for(const {result} of calls){
  assert(result.entries.length<=2);assert(result.entries.every(e=>e.record && Object.hasOwn(e,'annotation')));
  assert(result.entries.filter(e=>e.annotation).every(e=>e.record.item.text===undefined));
  assert(!JSON.stringify(result).includes('unrelated-review'));assert(!JSON.stringify(result).includes('private'));
  if(result.next){assert.equal(result.next.after.length,4);assert(result.next.snapshot);}
 }
 assert.deepEqual((await query.reviewedTimelinePage({...args,...dateRange})).rows,dated);
 const decoded=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString());
 const oldCursor=Buffer.from(JSON.stringify({binding:decoded.binding,offset:2,fingerprint:'0'.repeat(64)})).toString('base64url');
 await assert.rejects(query.reviewedTimelinePage({...args,limit:2,cursor:oldCursor}),/reviewed timeline cursor is stale/);
 decoded.position.after[3]=Number.MAX_SAFE_INTEGER;
 const missingAnchor=Buffer.from(JSON.stringify(decoded)).toString('base64url');
 await assert.rejects(query.reviewedTimelinePage({...args,limit:2,cursor:missingAnchor}),/invalid reviewed timeline cursor/);
 await archive.addAnnotation({scope,id:'unrelated-note',kind:'annotation',text:'unrelated note',target:ref(unrelated)});
 await query.reviewedTimelinePage({...args,limit:2,cursor:first.nextCursor});
 await archive.addAnnotation({scope,id:'later-state',kind:'task-state',text:'reopen',taskRoot:{kind:'annotation',id:'todo'},parents:['done'],state:'open',evidenceKind:'source',target:targetRef,evidence:proofRef});
 await assert.rejects(query.reviewedTimelinePage({...args,limit:2,cursor:first.nextCursor}),/stale/i);
 const fresh=await query.reviewedTimelinePage({...args,limit:2});
 await archive.addAnnotation({scope,id:'correction-2',kind:'correction',text:'correction 2',target:targetRef,revises:'decision',evidence:proofRef});
 await assert.rejects(query.reviewedTimelinePage({...args,limit:2,cursor:fresh.nextCursor}),/stale/i);
 const newer=await query.reviewedTimelinePage({...args,limit:2});
 await archive.addAnnotation({scope,id:'older',kind:'decision',text:'older review',topic:'Alias',target:targetRef,valid_time:'2025-01-01T00:00:00Z'});
 await assert.rejects(query.reviewedTimelinePage({...args,limit:2,cursor:newer.nextCursor}),/stale/i);
 archive.listItems=originalItems;archive.listAnnotations=originalAnnotations;
});
