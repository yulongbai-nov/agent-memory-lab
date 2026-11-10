'use strict';
// Real DSH + memory MCP, with a synthetic provider replay. The final text is
// derived only from the actual timeline tool result, not supplied in advance.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const cli='/opt/dsh-test/node_modules/.bin/dsh', patch='/opt/dsh-test/memory.patch.yml';
function objects(root) { const out=[], stack=[root]; while(stack.length){const x=stack.pop();if(!x||typeof x!=='object')continue;out.push(x);for(const v of Object.values(x))if(v&&typeof v==='object')stack.push(v);}return out; }
async function providerRecall(home) {
 const token=process.env.MEMLAB_PROXY_TOKEN;
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{24,128}$/.test(token))throw Error('gate');
 const ready=await fetch('http://172.28.88.2:8080/stats',{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
 if(!ready.ok)throw Error('proxy');
 const stats=await ready.json();if(stats.requestedModel!=='gpt-6-luna'||stats.requestedEffort!=='low'||!stats.limits)throw Error('proxy');
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,DSH_HOME:home,DSH_TELEMETRY_MODE:'OFF',LANG:'C.UTF-8',OPENAI_API_KEY:token};
 const args=['--profile','headless','--patch','/opt/dsh-test/provider.patch.yml','--patch',patch,'--patch','/opt/dsh-test/recall-provider.patch.yml','--json','--permission-mode','read-only','--approval-policy','never',
  'First use memory_find with keyword "release" and limit 5. For the selected topic, call memory_current and memory_timeline, passing only the selected topic to each. Read the next_step on the timeline row whose kind is "todo", including its marker. Call memory_evidence for both complete citations returned by memory_current: the original citation and the effective correction citation. Return only JSON with string fields topic, decision, next_step, original_revision, correction_revision, original_quote, correction_quote. Copy the reviewed decision and the full todo next_step exactly. Copy both revisions and a contiguous quote from each exact evidence result.'];
 const p=spawn(cli,args,{env,cwd:home,stdio:['ignore','pipe','ignore']});let out='',expired=false;
 const timer=setTimeout(()=>{expired=true;p.kill('SIGKILL');},90000);
 p.stdout.on('data',b=>{out+=b;if(out.length>1048576)p.kill('SIGKILL');});
 const code=await new Promise(resolve=>{p.on('error',()=>resolve(null));p.on('close',resolve);});clearTimeout(timer);
 let events;try{events=out.trim().split('\n').map(line=>JSON.parse(line));}catch{throw Error('events');}
 const calls=events.filter(e=>e.type==='tool_call' && /(?:^|__)memory_(?:find|current|timeline|evidence)$/.test(e.tool||''));
 const results=events.filter(e=>e.type==='tool_result' && e.status==='completed' && calls.some(c=>c.callId===e.callId));
 function unpack(value,depth=0) {
  if(depth>8)return null;
  if(typeof value==='string'){try{return unpack(JSON.parse(value.replace(/^Output:\s*/i,'')),depth+1);}catch{return value;}}
  if(Array.isArray(value)&&value.length===1&&value[0]?.type==='text')return unpack(value[0].text,depth+1);
  if(value?.type==='text')return unpack(value.text,depth+1);
  if(value?.content && !value.rows && !value.topics)return unpack(value.content,depth+1);
  return value;
 }
 function valuesFor(name){return calls.filter(c=>c.tool.endsWith('__memory_'+name)||c.tool==='memory_'+name).flatMap(c=>results.filter(r=>r.callId===c.callId).map(r=>unpack(r.result)));}
 const found=valuesFor('find').find(v=>v?.topics?.length===5&&v.coverage?.has_more&&v.topics.some(t=>t.topic==='Release rehearsal'));
 const current=valuesFor('current').flat().find(v=>v?.topic==='Release rehearsal'&&v.citation?.revision&&v.effectiveCitation?.revision&&v.citation.revision!==v.effectiveCitation.revision);
 const evidence=valuesFor('evidence');
 const original=evidence.find(v=>v?.revision===current?.citation.revision),corrected=evidence.find(v=>v?.revision===current?.effectiveCitation.revision);
 const timeline=valuesFor('timeline');
 const timelineRows=timeline.flatMap(v=>v?.rows||[]);
 const next=timelineRows.find(v=>v.kind==='todo'&&typeof v.next_step==='string'&&/MEMLAB_CANARY_[a-f0-9]{24}/.test(v.next_step));
 const final=events.find(e=>e.type==='final'&&e.reason?.kind==='completed');let answer;
 try{answer=JSON.parse(final?.text);}catch{}
 const valid=code===0&&!expired&&found&&current&&original&&corrected&&next&&answer&&
  answer.topic==='Release rehearsal'&&answer.decision===current.text&&answer.next_step===next.next_step&&
  answer.original_revision===original.revision&&answer.correction_revision===corrected.revision&&
  typeof answer.original_quote==='string'&&answer.original_quote.trim()&&original.text?.includes(answer.original_quote)&&
  typeof answer.correction_quote==='string'&&answer.correction_quote.trim()&&corrected.text?.includes(answer.correction_quote);
 if(!valid){console.error(JSON.stringify({event:'provider-recall-incomplete',code,expired,completed:Boolean(final),calls:calls.length,results:results.length,found:Boolean(found),current:Boolean(current),original:Boolean(original),corrected:Boolean(corrected),timelineResults:timeline.length,timelineRows:timelineRows.length,todo:Boolean(next),answerParsed:Boolean(answer)}));throw Error('acceptance');}
 console.log(JSON.stringify({harness:'dsh',lane:'provider-backed',status:'validated',matchedMcpCalls:calls.length,archiveOnlyCanaryVerified:true,distinctEvidenceVersions:2}));
}
let phase='fixture-access';
(async()=>{
 await fs.access('/memory/bin/memory.cjs'); await fs.access('/archive/.synthetic-harness-fixture');
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-recall-'));
 if(process.env.MEMLAB_RECALL_MODE==='provider'){phase='provider-recall';return providerRecall(home);}
 phase='replay-start';let stage=0,rejected=false,final;
 const steps=['find','current','evidence','evidence','timeline'];
 let current,original,corrected;
 function unpack(value,depth=0){
  if(depth>8)return null;
  if(typeof value==='string'){try{return unpack(JSON.parse(value.replace(/^Output:\s*/i,'')),depth+1);}catch{return value;}}
  if(Array.isArray(value)&&value.length===1&&value[0]?.type==='text')return unpack(value[0].text,depth+1);
  if(value?.type==='text')return unpack(value.text,depth+1);
  if(value?.content && !value.rows && !value.topics)return unpack(value.content,depth+1);
  return value;
 }
 const server=http.createServer(async(req,res)=>{
  try {
   if(req.method!=='POST'||req.url!=='/v1/messages'||stage>steps.length)throw Error('request');
   let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>524288)throw Error('size');chunks.push(b);}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));let blocks,reason,result,args;
   if(stage===0&&JSON.stringify(body.messages).includes('MEMLAB_CANARY_'))throw Error('preexposed');
   if(stage>0){
    const output=objects(body.messages).filter(x=>x.type==='tool_result'&&(x.tool_use_id==='synthetic_call_'+(stage-1)||x.tool_call_id==='synthetic_call_'+(stage-1)));
    if(output.length!==1)throw Error('tool result absent');
    result=unpack(output[0].content);
   }
   if(stage===0)args={keyword:'release',limit:5};
   if(stage===1){if(!result?.topics||result.topics.length!==5||!result.coverage?.has_more||!result.topics.some(t=>t.topic==='Release rehearsal'))throw Error('find');args={topic:'Release rehearsal'};}
   if(stage===2){current=Array.isArray(result)?result[0]:null;if(!current?.citation?.revision||!current?.effectiveCitation?.revision||current.citation.revision===current.effectiveCitation.revision)throw Error('current');args=current.citation;}
   if(stage===3){original=result;if(!original?.text||original.revision!==current.citation.revision)throw Error('original');args=current.effectiveCitation;}
   if(stage===4){corrected=result;if(!corrected?.text||corrected.revision!==current.effectiveCitation.revision)throw Error('correction');args={topic:'Release rehearsal'};}
   if(stage===5){
    const todo=result?.rows?.find(r=>typeof r.next_step==='string'&&/MEMLAB_CANARY_[a-f0-9]{24}/.test(r.next_step));
    if(!todo)throw Error('canary absent');
    final=JSON.stringify({topic:'Release rehearsal',decision:current.text,next_step:todo.next_step,original_revision:original.revision,correction_revision:corrected.revision,original_quote:original.text,correction_quote:corrected.text});
    blocks=[{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:final}},{type:'content_block_stop',index:0}];reason='end_turn';
   }else{
    const name='__memory_'+steps[stage];
    const tool=objects(body.tools).find(x=>typeof x.name==='string'&&x.name.endsWith(name));
    if(!tool)throw Error('no real tool');
    blocks=[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic_call_'+stage,name:tool.name,input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},{type:'content_block_stop',index:0}];reason='tool_use';
   }
   const events=[{type:'message_start',message:{id:'synthetic-'+stage,type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:1,output_tokens:0}}},...blocks,{type:'message_delta',delta:{stop_reason:reason},usage:{output_tokens:2}},{type:'message_stop'}];
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end('data: [DONE]\n\n');stage++;
  }catch(error){rejected=true;console.error(JSON.stringify({event:'provider-gate-rejected',stage,reason:['request','size','preexposed','no real tool','tool result absent','canary absent','find','current','original','correction'].includes(error.message)?error.message:'other'}));if(!res.headersSent)res.writeHead(400);res.end();}
 });
 phase='replay-listen';await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});phase='replay-spawn';
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,DSH_HOME:home,DSH_TELEMETRY_MODE:'OFF',LANG:'C.UTF-8',DEEPSEEK_API_KEY:'synthetic-key',DEEPSEEK_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`};
 const args=['--profile','headless','--patch',patch,'--patch','/opt/dsh-test/recall.patch.yml','--json','--permission-mode','read-only','--approval-policy','never','Find the next action for Release rehearsal using the memory timeline tool.'];
 const p=spawn(cli,args,{env,cwd:home,stdio:['ignore','pipe','pipe']});let out='',err='',expired=false;p.stderr.on('data',b=>{err=(err+b).slice(0,65536);});const timer=setTimeout(()=>{expired=true;p.kill('SIGKILL');},60000);
 p.stdout.on('data',b=>{out+=b;if(out.length>1048576)p.kill('SIGKILL');});
 const code=await new Promise(resolve=>{p.on('error',()=>resolve(null));p.on('close',resolve);});clearTimeout(timer);await new Promise(resolve=>server.close(resolve));
 phase='replay-parse';let events;try{events=out.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{throw Error('events');}
 const calls=events.filter(e=>e.type==='tool_call'&&steps.some(n=>(e.tool||'').endsWith('__memory_'+n)));
 const results=events.filter(e=>e.type==='tool_result'&&e.status==='completed'&&calls.some(c=>c.callId===e.callId));
 if(code!==0||expired||rejected||stage!==steps.length+1||calls.length!==steps.length||results.length!==steps.length||!final||!events.some(e=>e.type==='final'&&e.reason?.kind==='completed'&&e.text===final)){console.error(JSON.stringify({event:'replay-incomplete',code,expired,rejected,stage,hasFinal:Boolean(final),eventTypes:[...new Set(events.map(e=>e.type))],stderrExcerpt:err.split('\n').filter(line=>/error|failed|cannot|denied|mcp/i.test(line)).slice(0,4).map(line=>line.replace(/\/\S+/g,'[path]').replace(/MEMLAB_CANARY_[a-f0-9]{24}/g,'[canary]').replace(/[A-Za-z0-9_-]{24,}/g,'[identifier]').slice(0,250)),stderrClasses:['permission','module not found','Cannot find module','config','patch','sandbox','mcp','profile','ENOENT','EACCES','error'].filter(x=>err.toLowerCase().includes(x.toLowerCase()))}));throw Error('acceptance');}
 console.log(JSON.stringify({harness:'dsh',lane:'synthetic-protocol-replay',nativeCli:true,matchedMcpCalls:steps.length,archiveOnlyCanaryVerified:true,distinctEvidenceVersions:2,externalModelCalls:0}));
})().catch(error=>{console.error(JSON.stringify({status:'blocked',phase,code:typeof error.code==='string'?error.code:'unavailable',reason:['events','gate','proxy','acceptance'].includes(error.message)?error.message:'other'}));process.exitCode=1;});
