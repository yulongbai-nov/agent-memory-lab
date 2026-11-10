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
  'Call mcp__memory__memory_timeline for topic Release rehearsal. Return exactly the full next_step text from its todo entry.'];
 const p=spawn(cli,args,{env,cwd:home,stdio:['ignore','pipe','ignore']});let out='',expired=false;
 const timer=setTimeout(()=>{expired=true;p.kill('SIGKILL');},90000);
 p.stdout.on('data',b=>{out+=b;if(out.length>1048576)p.kill('SIGKILL');});
 const code=await new Promise(resolve=>{p.on('error',()=>resolve(null));p.on('close',resolve);});clearTimeout(timer);
 let events;try{events=out.trim().split('\n').map(line=>JSON.parse(line));}catch{throw Error('events');}
 const calls=events.filter(e=>e.type==='tool_call' && /(?:^|__)memory_timeline$/.test(e.tool||''));
 const results=events.filter(e=>e.type==='tool_result' && e.status==='completed' && calls.some(c=>c.callId===e.callId));
 const canaries=results.flatMap(e=>typeof e.result==='string'?(e.result.match(/MEMLAB_CANARY_[a-f0-9]{24}/g)||[]):[]);
 const values=[...new Set(canaries)];
 const steps=[];
 function findSteps(value,depth=0){
  if(depth>8)return;
  if(typeof value==='string'){try{findSteps(JSON.parse(value),depth+1);}catch{}return;}
  if(!value||typeof value!=='object')return;
  if(typeof value.next_step==='string' && /MEMLAB_CANARY_[a-f0-9]{24}/.test(value.next_step))steps.push(value.next_step);
  for(const child of Object.values(value))findSteps(child,depth+1);
 }
 for(const result of results)findSteps(result.result);
 const distinctSteps=[...new Set(steps)];
 const final=events.find(e=>e.type==='final'&&e.reason?.kind==='completed');
 if(code!==0||expired||calls.length!==1||results.length!==1||values.length!==1||distinctSteps.length!==1||typeof final?.text!=='string'||final.text.trim()!==distinctSteps[0]) {
  console.error(JSON.stringify({event:'provider-recall-incomplete',code,expired,timelineCalls:calls.length,timelineResults:results.length,canaryFound:values.length===1,completed:Boolean(final)}));
  throw Error('acceptance');
 }
 console.log(JSON.stringify({harness:'dsh',lane:'provider-backed',status:'validated',matchedMcpCalls:1,archiveOnlyCanaryVerified:true}));
}
let phase='fixture-access';
(async()=>{
 await fs.access('/memory/bin/memory.cjs'); await fs.access('/archive/.synthetic-harness-fixture');
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-recall-'));
 if(process.env.MEMLAB_RECALL_MODE==='provider'){phase='provider-recall';return providerRecall(home);}
 phase='replay-start';let stage=0,rejected=false,final;
 const server=http.createServer(async(req,res)=>{
  try {
   if(req.method!=='POST'||req.url!=='/v1/messages'||stage>1)throw Error('request');
   let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>524288)throw Error('size');chunks.push(b);}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));let blocks,reason;
   if(stage===0){
    if(JSON.stringify(body.messages).includes('MEMLAB_CANARY_'))throw Error('preexposed');
    const tool=objects(body.tools).find(x=>typeof x.name==='string'&&x.name.endsWith('__memory_timeline'));
    if(!tool)throw Error('no real tool');
    blocks=[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic_call',name:tool.name,input:{}}},
      {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({topic:'Release rehearsal'})}},
      {type:'content_block_stop',index:0}]; reason='tool_use';
   }else{
    const result=objects(body.messages).filter(x=>x.type==='tool_result' && (x.tool_use_id==='synthetic_call' || x.tool_call_id==='synthetic_call'));
    if(result.length!==1)throw Error('tool result absent');
    const match=JSON.stringify(result[0]).match(/MEMLAB_CANARY_[a-f0-9]{24}/g);
    if(!match || new Set(match).size!==1)throw Error('canary absent');
    final='Prepare the rehearsal checklist '+match[0];
    blocks=[{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:final}},{type:'content_block_stop',index:0}];reason='end_turn';
   }
   const events=[{type:'message_start',message:{id:'synthetic-'+stage,type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:1,output_tokens:0}}},...blocks,{type:'message_delta',delta:{stop_reason:reason},usage:{output_tokens:2}},{type:'message_stop'}];
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end('data: [DONE]\n\n');stage++;
  }catch(error){rejected=true;console.error(JSON.stringify({event:'provider-gate-rejected',stage,reason:['request','size','preexposed','no real tool','tool result absent','canary absent'].includes(error.message)?error.message:'other'}));if(!res.headersSent)res.writeHead(400);res.end();}
 });
 phase='replay-listen';await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});phase='replay-spawn';
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,DSH_HOME:home,DSH_TELEMETRY_MODE:'OFF',LANG:'C.UTF-8',DEEPSEEK_API_KEY:'synthetic-key',DEEPSEEK_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`};
 const args=['--profile','headless','--patch',patch,'--patch','/opt/dsh-test/recall.patch.yml','--json','--permission-mode','read-only','--approval-policy','never','Find the next action for Release rehearsal using the memory timeline tool.'];
 const p=spawn(cli,args,{env,cwd:home,stdio:['ignore','pipe','pipe']});let out='',err='',expired=false;p.stderr.on('data',b=>{err=(err+b).slice(0,65536);});const timer=setTimeout(()=>{expired=true;p.kill('SIGKILL');},60000);
 p.stdout.on('data',b=>{out+=b;if(out.length>1048576)p.kill('SIGKILL');});
 const code=await new Promise(resolve=>{p.on('error',()=>resolve(null));p.on('close',resolve);});clearTimeout(timer);await new Promise(resolve=>server.close(resolve));
 phase='replay-parse';let events;try{events=out.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{throw Error('events');}
 if(code!==0||expired||rejected||stage!==2||!final||!events.some(e=>e.type==='final'&&e.reason?.kind==='completed'&&e.text===final)){console.error(JSON.stringify({event:'replay-incomplete',code,expired,rejected,stage,hasFinal:Boolean(final),eventTypes:[...new Set(events.map(e=>e.type))],stderrExcerpt:err.split('\n').filter(line=>/error|failed|cannot|denied|mcp/i.test(line)).slice(0,4).map(line=>line.replace(/\/\S+/g,'[path]').replace(/MEMLAB_CANARY_[a-f0-9]{24}/g,'[canary]').replace(/[A-Za-z0-9_-]{24,}/g,'[identifier]').slice(0,250)),stderrClasses:['permission','module not found','Cannot find module','config','patch','sandbox','mcp','profile','ENOENT','EACCES','error'].filter(x=>err.toLowerCase().includes(x.toLowerCase()))}));throw Error('acceptance');}
 console.log(JSON.stringify({harness:'dsh',lane:'synthetic-protocol-replay',nativeCli:true,realMcpTimeline:true,archiveOnlyCanaryVerified:true,externalModelCalls:0}));
})().catch(error=>{console.error(JSON.stringify({status:'blocked',phase,code:typeof error.code==='string'?error.code:'unavailable',reason:['events','gate','proxy','acceptance'].includes(error.message)?error.message:'other'}));process.exitCode=1;});
