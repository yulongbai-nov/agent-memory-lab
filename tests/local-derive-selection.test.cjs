'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {selectLocalBatch} = require('../lib/local-derive-selection.cjs');
const {originalCapture} = require('../lib/originals.cjs');

test('selection prefers substantive same-turn records and excludes unsafe or missing previews', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'derive-select-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const capture = originalCapture(dir);
  const source = {harness:'dsh',instance:'i',session:'s'};
  const row = async (id,turnId,role,text,coordinate,ref) => ({source,versionId:'v-'+id,item:{id,turnId,role,text,metadata:{
    coordinate,original:ref || await capture({bytes:Buffer.from(JSON.stringify({type:role+'/message',data:{role,text}})+'\n'),coordinate})
  }}});
  const rows = await Promise.all([
    row('noise','recent','user','Thank you!',1),
    row('plain','other','user','A simple ordinary conversation.',2),
    row('secret','good','user','Contact private@example.com please.',3),
    row('missing','good','user','We decided to use the missing item.',4,{availability:'source-only'}),
    row('user','good','user','We decided to ship on Tuesday instead.',5),
    row('assistant','good','assistant','Next step: prepare the release notes.',6),
    row('ack','good','assistant','Okay!',7),
    row('unrelated','other','assistant','The other topic is separate.',8)
  ]);
  const archive = {dir, async localDeriveMessages() {return rows;}};
  const result = await selectLocalBatch(archive,{owner:'o',project:'p'});
  assert.deepEqual(result.records.map(r=>r.item),['user','assistant']);
  assert.equal(result.records[0].text,rows[4].item.text);
  assert.equal(result.records[0].version,'v-user');
  assert.equal(result.availability.unavailableConsidered,1);
  assert.deepEqual(await selectLocalBatch(archive,{owner:'o',project:'p'}),result);
});

test('JSON escaping and text length remain bounded without truncating evidence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'derive-budget-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const capture = originalCapture(dir);
  const source = {harness:'codex',instance:'i',session:'s'};
  const rows = await Promise.all(Array.from({length:8},async (_,i)=>{
    const role=i?'assistant':'user';
    const text=(i?'Next step: ':'We decided: ')+('"\\ '.repeat(35));
    const original=await capture({bytes:Buffer.from(JSON.stringify({type:'response_item',payload:{type:'message',role,content:text}})+'\n'),coordinate:i});
    return {source,versionId:'v'+i,item:{id:'i'+i,turnId:'t',role,text,metadata:{coordinate:i,original}}};
  }));
  const result = await selectLocalBatch({dir,localDeriveMessages:async()=>rows},{owner:'o',project:'p'});
  assert(result.records.length > 0 && result.records.length <= 5);
  assert(result.records.reduce((sum,r)=>sum+Buffer.byteLength(r.text),0)<=650);
  const aliases = result.records.map((r,i)=>({source:'source-1',item:'message-'+(i+1),version:'v1',text:r.text}));
  assert(Buffer.byteLength(JSON.stringify(aliases)) <= 900);
  assert(result.records.every(r=>rows.some(row=>row.item.id===r.item && row.item.text===r.text)));
});
