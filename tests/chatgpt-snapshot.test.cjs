'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openArchive } = require('../lib/archive.cjs');
const { sourceIdentity } = require('../lib/adapters');
const { readChatgptSnapshot } = require('../lib/adapters/chatgpt-snapshot.cjs');

function fixture(representation = 'connector-projection') {
  return {schema:'agent-memory-chatgpt-snapshot',version:1,representation,conversation:{id:'synthetic-thread',created_at:'2026-01-01T00:00:00Z',branches_complete:false,attachments_complete:false},messages:[1,2,3].map(n=>({id:`message-${n}`,role:n===2?'assistant':'user',text:`synthetic ${n}`,created_at:`2026-01-01T00:00:0${n}Z`,truncated:n===2}))};
}
test('snapshot import resumes bounded batches, preserves coverage, and enforces CAS', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'chatgpt-snapshot-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'snapshot.json'); await fs.writeFile(file,JSON.stringify(fixture()));
  const archive=await openArchive({dir:path.join(dir,'archive')});
  const opts={file,owner:'synthetic',project:'fixture',instance:'test',session:'synthetic-thread',maxRecords:2,batchSize:1};
  const batches=[]; for await(const batch of readChatgptSnapshot(opts)) batches.push(batch);
  assert.equal(batches.length,2); assert.equal(batches[0].items[0].metadata.originalBytes,false);
  assert.equal(batches[1].items[0].metadata.truncated,true);
  assert.deepEqual(batches[1].source.coverage.gaps.map(g=>g.reason),['connector-projection','branches-incomplete','attachments-incomplete','truncated-items','scan-limit']);
  for(const batch of batches) await archive.importBatch(batch);
  await assert.rejects(archive.importBatch({...batches[0], items:[{...batches[0].items[0], text:'conflict'}]}),/Checkpoint conflict/);
  const checkpoint=await archive.getCheckpoint({...opts,...sourceIdentity({harness:'chatgpt',instance:opts.instance,session:opts.session})});
  const resumed=[]; for await(const batch of readChatgptSnapshot({...opts,checkpoint})) resumed.push(batch);
  assert.equal(resumed.length,1); assert.equal(resumed[0].checkpoint.previous,2); await archive.importBatch(resumed[0]);
  const final=await archive.getCheckpoint({...opts,...sourceIdentity({harness:'chatgpt',instance:opts.instance,session:opts.session})});
  assert.equal(final.position,3); assert.equal((await archive.listItems(opts)).length,3);
  const again=[]; for await(const batch of readChatgptSnapshot({...opts,checkpoint:final})) again.push(batch); assert.deepEqual(again,[]);
  await fs.writeFile(file,JSON.stringify({...fixture(),messages:fixture().messages.slice(0,2)}));
  await assert.rejects(async()=>{for await(const _ of readChatgptSnapshot({...opts,checkpoint:final})) {}},/checkpoint mismatch/);
});
test('rejects unknown shape and distinguishes normalized export completeness', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'chatgpt-snapshot-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'snapshot.json'); const opts={file,owner:'o',project:'p',instance:'i',session:'synthetic-thread'};
  for(const bad of [{...fixture(),version:2},{...fixture(),unknown:true},{...fixture(),messages:[{...fixture().messages[0],id:''}]}]) {
    await fs.writeFile(file,JSON.stringify(bad)); await assert.rejects(async()=>{for await(const _ of readChatgptSnapshot(opts)) {}},/Invalid/);
  }
  const clean=fixture('official-export-normalized'); clean.conversation.branches_complete=true; clean.conversation.attachments_complete=true; clean.messages.forEach(m=>m.truncated=false); await fs.writeFile(file,JSON.stringify(clean));
  const batches=[]; for await(const batch of readChatgptSnapshot(opts)) batches.push(batch);
  assert.equal(batches[0].source.coverage.complete,true); assert.equal(batches[0].source.representation,'official-export-normalized');
});
