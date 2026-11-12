'use strict';
// Only accepts the disposable DSH session tree produced by this benchmark.
const fs=require('node:fs/promises'), path=require('node:path'), crypto=require('node:crypto');
const {discover}=require('../../lib/discover.cjs');
const {readDsh}=require('../../lib/adapters');
const {openArchive}=require('../../lib/archive.cjs');
const {originalCapture,verifyOriginal}=require('../../lib/originals.cjs');
const {createQuery}=require('../../lib/query.cjs');
const assert=require('node:assert/strict');
let phase='arguments';
(async()=>{
 const [sessions,dir]=process.argv.slice(2); if(!sessions||!dir)throw Error('synthetic inputs required');
 const scope={owner:'synthetic',project:'release'},archive=await openArchive({dir});
 phase='discover';
 const files=(await discover(sessions,'dsh',{maximum:100})).files; if(files.length!==2)throw Error('expected two independent native sessions');
 phase='import-native';
 const capture=originalCapture(archive.dir);
 for(const {file,session} of files) for await(const batch of readDsh({...scope,instance:'dsh-container',session,file,captureOriginal:capture,maxRecords:1000,lookback:0})) await archive.importBatch(batch);
 phase='source-messages';
 const items=await archive.listItems(scope);
 const first=items.find(v=>v.item.role==='user' && v.item.text?.includes('Synthetic planning record:'));
 const second=items.find(v=>v.item.role==='user' && v.item.text?.includes('Synthetic correction record:'));
 assert.ok(first&&second&&first.source.session!==second.source.session,'independent source messages missing');
 phase='original-digests';
 for(const v of [first,second]) {assert.equal((await verifyOriginal(archive.dir,v.item.metadata?.original)).verified,true);assert.equal(v.source.harness,'dsh');}
 phase='assistant-and-terminal';
 for (const session of [first.source.session,second.source.session]) {
  assert.ok(items.some(v=>v.source.session===session && v.item.role==='assistant'),'assistant turn missing');
  assert.ok(items.some(v=>v.source.session===session && v.item.status==='completed'),'terminal turn missing');
 }
 phase='reviews';
 const citation=v=>({id:v.item.id,revision:v.versionId,source:v.source});
 const target=citation(first), evidence=citation(second), canary='MEMLAB_CANARY_'+crypto.randomBytes(12).toString('hex');
 await archive.addAnnotation({scope,id:'fixture-reviewed',kind:'decision',topic:'Release rehearsal',text:'Production release Tuesday noon',target});
 await archive.addAnnotation({scope,id:'fixture-correction',kind:'correction',topic:'Release rehearsal',text:'The agreed Tuesday noon plan is a rehearsal, not a production release.',target,evidence,revises:'fixture-reviewed'});
 await archive.addAnnotation({scope,id:'fixture-todo',kind:'todo',topic:'Release rehearsal',text:'Prepare the rehearsal checklist '+canary,target});
 phase='distractors';
 const fakeSource={harness:'fixture',instance:'isolated',session:'distractors'};
 await archive.importBatch({scope,source:fakeSource,checkpoint:{position:1},items:[{id:'anchor',kind:'message',text:'release rehearsal index',time:'2090-01-01T00:00:00Z',metadata:{topic:'Release rehearsal'}},...Array.from({length:7},(_,i)=>({id:'d'+i,kind:'message',text:'release distractor '+i,time:'2000-01-0'+(i+1)+'T00:00:00Z',metadata:{topic:'release distractor '+i}}))]});
 const other={owner:'synthetic',project:'other'};
 await archive.importBatch({scope:other,source:fakeSource,checkpoint:{position:1},items:[{id:'cross',kind:'message',text:'release other scope secret',time:'2100-01-01T00:00:00Z'}]});
 phase='shortlist';
 const q=createQuery(archive), found=await q.find({...scope,keyword:'release',limit:5});
 assert.equal(found.topics.length,5); assert.ok(found.coverage.has_more); assert.ok(found.topics.some(t=>t.topic==='Release rehearsal')); assert.ok(!JSON.stringify(found).includes('other scope'));
 phase='correction';
 const now=await q.current({...scope,topic:'Release rehearsal'}); assert.equal(now[0].effectiveCitation.revision,evidence.revision);
 phase='marker';
 await fs.writeFile(path.join(archive.dir,'.synthetic-harness-fixture'),'synthetic-only\n',{mode:0o600,flag:'wx'});
 archive.close?.();
 console.log(JSON.stringify({sourceSessions:2,assistantTurns:2,terminalTurns:2,verifiedOriginals:2,hasMore:true}));
})().catch(error=>{console.error(JSON.stringify({status:'blocked',stage:'fixture',phase,code:['EACCES','ENOENT','ASSERTION_ERROR','ERR_ASSERTION'].includes(error.code)?error.code:'invalid'}));process.exitCode=1;});
