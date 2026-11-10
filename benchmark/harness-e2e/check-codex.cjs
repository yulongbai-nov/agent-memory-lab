'use strict';
// Read only the generated fixture session provided as an argument, never user history.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {openArchive}=require('../../lib/archive.cjs');
const {readCodex}=require('../../lib/adapters');
const {createQuery}=require('../../lib/query.cjs');
(async()=>{
 const file=process.argv[2]; if(!file) throw Error('Synthetic session path required');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-harness-test-'));
 try {
  const scope={owner:'synthetic',project:'harness-e2e'},archive=await openArchive({dir});
  for await (const batch of readCodex({...scope,instance:'container',session:'fixture',file,maxRecords:1000,lookback:0})) await archive.importBatch(batch);
  const versions=await archive.listItems(scope); assert.ok(versions.length>0,'empty synthetic session');
  const query=createQuery(archive), found=await query.find({...scope,keyword:'synthetic'}); assert.ok(found.topics.length,'synthetic session not searchable');
  const version=versions.find(v=>v.item.role==='assistant' && v.item.text==='Synthetic response: the plan is Tuesday.');
  assert.ok(version,'synthetic content missing');
  const target={id:version.item.id,revision:version.versionId,source:version.source};
  assert.equal((await query.evidence({...scope,...target})).revision,version.versionId);
  await query.annotate({...scope,id:'fixture-decision',kind:'decision',text:'Fixture plan',target});
  await query.annotate({...scope,id:'fixture-change',kind:'change',text:'Fixture revised plan',target,revises:'fixture-decision'});
  await query.annotate({...scope,id:'fixture-correction',kind:'correction',text:'Fixture correction',target,revises:'fixture-change'});
  assert.equal((await query.annotations(scope)).length,3);
  console.log('PASS: synthetic Codex session import, evidence and review revisions');
  archive.close?.();
 } finally {await fs.rm(dir,{recursive:true,force:true});}
})().catch(()=>{console.error('FAIL: synthetic Codex import validation');process.exitCode=1;});
