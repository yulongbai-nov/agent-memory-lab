'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {originalCapture}=require('../lib/originals.cjs');
const {previewProjections,verifiedProjections}=require('../lib/local-derive-projection.cjs');

test('full, ranked fragments, relay boundaries and unknown wrappers',()=>{
  const p=previewProjections('First sentence. We decided the next step.',s=>s.includes('decided')?10:0);
  assert.equal(p[0].kind,'full'); assert(p.some(x=>x.kind==='fragment' && x.text.includes('decided')));
  const long='Routine sentence. '.repeat(40)+'We decided to proceed. '+ 'More context. '.repeat(40);
  const ranked=previewProjections(long,s=>s.includes('decided')?10:0);
  assert(ranked.length<=8 && ranked[0].text.includes('decided'));
  for (const x of ranked) {assert.equal(long.slice(x.start,x.end),x.text);assert(Buffer.byteLength(x.text)<=450);}
  const relay='<realtime_delegation><source_thread_id>synthetic-1</source_thread_id><input>We decided to proceed.</input></realtime_delegation>';
  const [r]=previewProjections(relay); assert.equal(r.kind,'relay-input'); assert.equal(relay.slice(r.start,r.end),r.text);
  assert.deepEqual(previewProjections('<realtime_delegation><unknown>data</unknown></realtime_delegation>'),[]);
});

test('only unique verified original fields map with exact UTF offsets',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'projection-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const text='你好 😀 We decided to ship. Next step: test.';
  const raw={type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}};
  const ref=await originalCapture(dir)({bytes:Buffer.from(JSON.stringify(raw)+'\n'),coordinate:1});
  const row={source:{harness:'codex'},item:{role:'user',text,metadata:{original:ref}}};
  const choices=previewProjections(text,s=>s.includes('Next')?10:0);
  const verified=await verifiedProjections(dir,row,choices);
  assert(verified.length>0); const p=verified[0].projection;
  assert.equal(p.fieldPath,'payload.content.0.text'); assert.equal(text.slice(p.startUtf16,p.endUtf16),verified[0].text);
  assert.equal(p.endUtf8,Buffer.byteLength(text.slice(0,p.endUtf16))); assert.equal(p.originalSha256,ref.sha256);
  const duplicate={...raw,payload:{...raw.payload,content:[{type:'input_text',text},{type:'input_text',text}]}};
  const ref2=await originalCapture(dir)({bytes:Buffer.from(JSON.stringify(duplicate)+'\n'),coordinate:2});
  assert.deepEqual(await verifiedProjections(dir,{...row,item:{...row.item,metadata:{original:ref2}}},choices),[]);
  await fs.writeFile(path.join(dir,'originals',ref.sha256+'.jsonl'),Buffer.alloc(ref.bytes,65));
  assert.deepEqual(await verifiedProjections(dir,row,choices),[]);
});

test('relay only matches input content, never transport metadata',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'projection-relay-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const text='<realtime_delegation><source_thread_id>synthetic</source_thread_id><input>Next step: test.</input></realtime_delegation>';
  const raw={type:'user/message',data:{role:'user',message:{content:text}}};
  const ref=await originalCapture(dir)({bytes:Buffer.from(JSON.stringify(raw)+'\n'),coordinate:1});
  const row={source:{harness:'dsh'},item:{role:'user',text,metadata:{original:ref}}};
  const [result]=await verifiedProjections(dir,row,previewProjections(text));
  assert.equal(result.text,'Next step: test.');assert.equal(result.projection.kind,'relay-input');
  assert.equal(result.projection.fieldPath,'data.message.content');
  assert.deepEqual(await verifiedProjections(dir,row,[{kind:'relay-input',text:'synthetic',start:text.indexOf('synthetic'),end:text.indexOf('synthetic')+9}]),[]);
});
