'use strict';
// Real DSH + memory MCP, with a synthetic provider replay. The final text is
// derived only from the actual timeline tool result, not supplied in advance.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const cli='/opt/dsh-test/node_modules/.bin/dsh', patch='/opt/dsh-test/memory.patch.yml';
function objects(root) { const out=[], stack=[root]; while(stack.length){const x=stack.pop();if(!x||typeof x!=='object')continue;out.push(x);for(const v of Object.values(x))if(v&&typeof v==='object')stack.push(v);}return out; }
const PROMPT_VERSION='dsh-synthetic-recall-v1';
const OBSERVATION_FILE='/tmp/memlab-dsh-mcp-observations.jsonl';
const REVIEW_IDS=new Set(['fixture-reviewed','fixture-correction','fixture-todo']);
const ALLOWED_PARAMS=new Set(['topic','keyword','from','to','limit','offset','asOf']);
function unpackTelemetry(v,depth=0) {
 if(depth>8)return null;
 if(typeof v==='string'){try{return unpackTelemetry(JSON.parse(v.replace(/^Output:\s*/i,'')),depth+1);}catch{return null;}}
 if(Array.isArray(v)&&v.length===1&&v[0]?.type==='text')return unpackTelemetry(v[0].text,depth+1);
 if(v?.type==='text')return unpackTelemetry(v.text,depth+1);
 if(v?.content&&!v.rows&&!v.topics)return unpackTelemetry(v.content,depth+1);
 return v;
}
function timelineShape(value,rawBytes,wrapperBytes) {
 const v=unpackTelemetry(value), rows=Array.isArray(v?.rows)?v.rows:[];
 return {rows:rows.length,kinds:[...new Set(rows.map(r=>r?.kind).filter(k=>['source','decision','correction','change','todo','annotation'].includes(k)))].sort(),
  reviewIds:[...new Set(rows.flatMap(r=>[r?.review_id,...(Array.isArray(r?.annotations)?r.annotations.map(a=>a?.id):[]) ]).filter(x=>REVIEW_IDS.has(x)))].sort(),
  coverage:{total:Number.isSafeInteger(v?.coverage?.total)?v.coverage.total:null,offset:Number.isSafeInteger(v?.coverage?.offset)?v.coverage.offset:null,has_more:typeof v?.coverage?.has_more==='boolean'?v.coverage.has_more:null},
  rawBytes,wrapperBytes,canaryPresent:/MEMLAB_CANARY_[a-f0-9]{24}/.test(JSON.stringify(value)),
  explicitTruncation:Boolean(v?.truncated||v?.coverage?.truncated),possible8KiBCap:rawBytes>=8192,possible32KiBCap:wrapperBytes>=32768};
}
function observationArgs(args){const keys=Object.keys(args&&typeof args==='object'?args:{});const number=k=>Number.isSafeInteger(args?.[k])&&args[k]>=0&&args[k]<=10000?args[k]:null;return {parameterKeys:keys.filter(k=>ALLOWED_PARAMS.has(k)).sort(),unknownParameterCount:keys.filter(k=>!ALLOWED_PARAMS.has(k)).length,hasKeyword:typeof args?.keyword==='string'&&args.keyword.trim().length>0,matchesRelease:typeof args?.keyword==='string'&&args.keyword.toLowerCase().includes('release'),limit:number('limit'),offset:number('offset')};}
// Transparent stdio observer, limited to the disposable synthetic fixture.
function observeMcp(){
 const fss=require('node:fs'),{StringDecoder}=require('node:string_decoder');
 const dest=OBSERVATION_FILE;
 try {const st=fss.lstatSync(dest);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||!fss.existsSync('/archive/.synthetic-harness-fixture'))process.exit(1);}catch{process.exit(1);}
 const child=spawn('node',['/memory/bin/memory.cjs','mcp','--dir','/archive','--owner','synthetic','--project','release'],
  {env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['pipe','pipe','inherit']});
 const pending=new Map();let emitted=0;
 const emit=value=>{if(emitted++>=40)return;let fd;try{fd=fss.openSync(dest,fss.constants.O_WRONLY|fss.constants.O_APPEND|fss.constants.O_NOFOLLOW);const st=fss.fstatSync(fd);if(!st.isFile()||(st.mode&0o077)||st.uid!==process.getuid())throw Error('invalid observer file');fss.writeSync(fd,JSON.stringify(value)+'\n');}catch{process.exitCode=1;child.kill();}finally{if(fd!==undefined)fss.closeSync(fd);}};
 function watch(stream,callback){const d=new StringDecoder('utf8');let carry='',overflow=false;
  stream.on('data',chunk=>{carry+=d.write(chunk);if(carry.length>2097152){carry='';overflow=true;return;}
   let i;while((i=carry.indexOf('\n'))!==-1){const line=carry.slice(0,i);carry=carry.slice(i+1);if(overflow){overflow=false;continue;}try{callback(JSON.parse(line),Buffer.byteLength(line));}catch{}}});
 }
 watch(process.stdin,msg=>{if(msg.method==='tools/call'&&msg.params?.name==='memory_timeline'){
  if(pending.size>=100)return;pending.set(String(msg.id),true);emit({event:'mcp-request',...observationArgs(msg.params.arguments)});}});
 watch(child.stdout,(msg,size)=>{if(pending.delete(String(msg.id))){const text=msg.result?.content?.find(x=>x.type==='text')?.text;
  emit({event:'mcp-response',...timelineShape(text,typeof text==='string'?Buffer.byteLength(text):0,size)});}});
 process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
 child.on('error',()=>{process.exitCode=1;});child.on('close',code=>{process.exitCode=code||0;});
}
function observeDsh(events) {
 const calls=events.filter(e=>e.type==='tool_call'&&/(?:^|__)memory_timeline$/.test(e.tool||'')).slice(0,40);
 const observations=[];
 for(const call of calls){observations.push({event:'dsh-call',...observationArgs(call.input)});
  for(const result of events.filter(e=>e.type==='tool_result'&&e.callId===call.callId)){
   const raw=Buffer.byteLength(typeof result.result==='string'?result.result:JSON.stringify(result.result ?? null));
   const shape=timelineShape(result.result,raw,Buffer.byteLength(JSON.stringify(result)));
   shape.explicitTruncation ||= result.truncated === true;
   observations.push({event:'dsh-result',status:result.status==='completed'?'completed':'other',...shape});
  }}
 const final=events.find(e=>e.type==='final');
 observations.push({event:'final',completed:final?.reason?.kind==='completed',canaryPresent:typeof final?.text==='string'&&/MEMLAB_CANARY_[a-f0-9]{24}/.test(final.text),markerPresent:typeof final?.text==='string'&&final.text.includes('MEMLAB_CANARY_')});
 return observations;
}
async function reportTelemetry(events,lane){
 let entries=[];try{const text=await fs.readFile(OBSERVATION_FILE,'utf8');if(Buffer.byteLength(text)<=131072)entries=text.trim().split('\n').filter(Boolean).slice(0,200).map(line=>JSON.parse(line));}catch{}
 const dsh=observeDsh(events);console.log(JSON.stringify({event:'timeline-telemetry',lane,promptVersion:PROMPT_VERSION,mcp:entries,dsh}));
 return {mcp:entries,dsh};
}
async function providerRecall(home) {
 const token=process.env.MEMLAB_PROXY_TOKEN;
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{24,128}$/.test(token))throw Error('gate');
 const ready=await fetch('http://172.28.88.2:8080/stats',{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
 if(!ready.ok)throw Error('proxy');
 const stats=await ready.json();if(stats.requestedModel!=='gpt-6-luna'||stats.requestedEffort!=='low'||!stats.limits)throw Error('proxy');
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,DSH_HOME:home,DSH_TELEMETRY_MODE:'OFF',LANG:'C.UTF-8',OPENAI_API_KEY:token};
 const args=['--profile','headless','--patch','/opt/dsh-test/provider.patch.yml','--patch',patch,'--patch','/opt/dsh-test/recall-provider.patch.yml','--json','--permission-mode','read-only','--approval-policy','never',
  'Use memory_find with keyword release and limit 5, then memory_current and memory_timeline for the selected Release rehearsal topic. Call memory_evidence for both the original citation and effective correction citation returned by memory_current. Return only JSON with string fields topic, decision, next_step, original_revision, correction_revision, original_quote, correction_quote. Copy the reviewed current decision and full todo next_step exactly. Revisions must exactly match the two evidence results; each quote must be a nonempty contiguous excerpt of its corresponding evidence text.'];
 const p=spawn(cli,args,{env,cwd:home,stdio:['ignore','pipe','ignore']});let out='',expired=false;
 const timer=setTimeout(()=>{expired=true;p.kill('SIGKILL');},90000);
 p.stdout.on('data',b=>{out+=b;if(out.length>1048576)p.kill('SIGKILL');});
 const code=await new Promise(resolve=>{p.on('error',()=>resolve(null));p.on('close',resolve);});clearTimeout(timer);
 let events;try{events=out.trim().split('\n').map(line=>JSON.parse(line));}catch{throw Error('events');}
 await reportTelemetry(events,'provider-backed');
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
 const next=valuesFor('timeline').flatMap(v=>v?.rows||[]).find(v=>typeof v.next_step==='string'&&/MEMLAB_CANARY_[a-f0-9]{24}/.test(v.next_step));
 const final=events.find(e=>e.type==='final'&&e.reason?.kind==='completed');let answer;
 try{answer=JSON.parse(final?.text);}catch{}
 const valid=code===0&&!expired&&found&&current&&original&&corrected&&next&&answer&&
  answer.topic==='Release rehearsal'&&answer.decision===current.text&&answer.next_step===next.next_step&&
  answer.original_revision===original.revision&&answer.correction_revision===corrected.revision&&
  typeof answer.original_quote==='string'&&answer.original_quote.trim()&&original.text?.includes(answer.original_quote)&&
  typeof answer.correction_quote==='string'&&answer.correction_quote.trim()&&corrected.text?.includes(answer.correction_quote);
 if(!valid){console.error(JSON.stringify({event:'provider-recall-incomplete',code,expired,completed:Boolean(final),calls:calls.length,results:results.length,found:Boolean(found),current:Boolean(current),original:Boolean(original),corrected:Boolean(corrected),todo:Boolean(next),answerParsed:Boolean(answer)}));throw Error('acceptance');}
 console.log(JSON.stringify({harness:'dsh',lane:'provider-backed',status:'validated',matchedMcpCalls:calls.length,archiveOnlyCanaryVerified:true,distinctEvidenceVersions:2}));
}
let phase='fixture-access';
if(process.argv[2]==='--observe-mcp') observeMcp();
else (async()=>{
 await fs.access('/memory/bin/memory.cjs'); await fs.access('/archive/.synthetic-harness-fixture');
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-recall-'));
 const telemetryFile=await fs.open(OBSERVATION_FILE,'wx',0o600);await telemetryFile.close();
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
 const telemetry=await reportTelemetry(events,'synthetic-protocol-replay');
 const calls=events.filter(e=>e.type==='tool_call'&&steps.some(n=>(e.tool||'').endsWith('__memory_'+n)));
 const results=events.filter(e=>e.type==='tool_result'&&e.status==='completed'&&calls.some(c=>c.callId===e.callId));
 if(code!==0||expired||rejected||stage!==steps.length+1||!telemetry.mcp.some(e=>e.event==='mcp-response'&&e.canaryPresent)||!telemetry.dsh.some(e=>e.event==='final'&&e.markerPresent)||calls.length!==steps.length||results.length!==steps.length||!final||!events.some(e=>e.type==='final'&&e.reason?.kind==='completed'&&e.text===final)){console.error(JSON.stringify({event:'replay-incomplete',code,expired,rejected,stage,hasFinal:Boolean(final),eventTypes:[...new Set(events.map(e=>e.type))],stderrExcerpt:err.split('\n').filter(line=>/error|failed|cannot|denied|mcp/i.test(line)).slice(0,4).map(line=>line.replace(/\/\S+/g,'[path]').replace(/MEMLAB_CANARY_[a-f0-9]{24}/g,'[canary]').replace(/[A-Za-z0-9_-]{24,}/g,'[identifier]').slice(0,250)),stderrClasses:['permission','module not found','Cannot find module','config','patch','sandbox','mcp','profile','ENOENT','EACCES','error'].filter(x=>err.toLowerCase().includes(x.toLowerCase()))}));throw Error('acceptance');}
 console.log(JSON.stringify({harness:'dsh',lane:'synthetic-protocol-replay',nativeCli:true,matchedMcpCalls:steps.length,archiveOnlyCanaryVerified:true,distinctEvidenceVersions:2,externalModelCalls:0}));
})().catch(error=>{console.error(JSON.stringify({status:'blocked',phase,code:typeof error.code==='string'?error.code:'unavailable',reason:['events','gate','proxy','acceptance'].includes(error.message)?error.message:'other'}));process.exitCode=1;});
