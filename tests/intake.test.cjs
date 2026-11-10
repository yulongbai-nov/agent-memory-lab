'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {intakeDirectory} = require('../lib/intake.cjs');
test('bounded background intake survives restarts, retries failures and advances through changing catalog', async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'intake-test-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'sessions'), store=path.join(root,'private'); await fs.mkdir(source); await fs.mkdir(store,{mode:0o700});
 for(let i=0;i<11;i++) await fs.writeFile(path.join(source,`${i}.jsonl`),'a\n');
 const op={scope:{owner:'o',project:'p'},archive:{dir:store}}, input={root:source,instance:'test',source:'codex','max-sessions':'3'};
 const seen=new Map(), offsets=new Map(); let failed=false;
 const ingest=async (_op,{file,session})=>{
   seen.set(session,(seen.get(session)||0)+1);
   if (!failed) {failed=true; throw Error('synthetic');}
   const n=(await fs.readFile(file,'utf8')).length, old=offsets.get(session)||0; offsets.set(session,n);
   return {itemsImported:n-old};
 };
 const first=await intakeDirectory(op,input,ingest); assert.equal(first.sessionsFailed,1); assert.ok(first.sessionsAttempted<=3);
 for(let i=0;i<10;i++) { const result=await intakeDirectory(op,input,ingest); assert.ok(result.sessionsAttempted<=3); }
 assert.equal(offsets.size,11); assert.ok([...seen.values()].some(n=>n>1));
 await fs.writeFile(path.join(source,'new.jsonl'),'new\n');
 await fs.appendFile(path.join(source,'0.jsonl'),'later\n');
 for(let i=0;i<9;i++) await intakeDirectory(op,input,ingest);
 assert.equal(offsets.get('new.jsonl'),4); assert.equal(offsets.get('0.jsonl'),8);
 const state=await fs.readFile(path.join(store,(await fs.readdir(store)).find(x=>x.endsWith('.json'))),'utf8');
 assert.ok(!state.includes(source)); assert.ok(!state.includes('.jsonl')); assert.ok(!state.includes('0.jsonl'));
});
