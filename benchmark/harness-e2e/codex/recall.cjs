'use strict';

// A synthetic protocol replay with a real CLI and real stdio MCP. The fixture
// provider cannot answer until it has received the actual tool results.
const http = require('node:http');
const fs = require('node:fs/promises');
const {spawn,spawnSync} = require('node:child_process');
const {join} = require('node:path');
const {homedir} = require('node:os');

const topic = 'Release rehearsal';
const steps = ['memory_find','memory_current','memory_evidence','memory_evidence','memory_timeline'];
const archive = '/archive';
const cliPath = '/memory/bin/memory.cjs';
function codexEnv(configDir) {
  return {PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:configDir};
}
async function functionToolCatalog(configDir) {
  const path=join(configDir,'fixture-models.json');
  const result=spawnSync('codex',['debug','models','--bundled'],{
    env:codexEnv(configDir),encoding:'utf8',timeout:5000,maxBuffer:1048576
  });
  if(result.status!==0)throw Error('bundled model metadata unavailable');
  const model=JSON.parse(result.stdout).models.find(entry=>entry.slug==='gpt-6-luna');
  if(!model)throw Error('bundled Luna model unavailable');
  // The bundled Luna entry defaults to Code Mode and Responses Lite. This
  // fixture uses ordinary Responses function calls for its five MCP tools.
  delete model.tool_mode;
  model.use_responses_lite=false;
  model.supports_search_tool=false;
  await fs.writeFile(path,JSON.stringify({models:[model]}),{flag:'wx',mode:0o600});
  return path;
}
function matchesCitation(result, citation) {
  return citation && result.id===citation.id && result.revision===citation.revision &&
    ['harness','instance','session'].every(key=>result.source?.[key]===citation.source?.[key]);
}
function matchesQuote(evidence, quote) {
  return typeof quote==='string' && typeof evidence.text==='string' &&
    quote.trim().length>=Math.min(18,evidence.text.trim().length) && evidence.text.includes(quote);
}
function unpack(value, depth=0) {
  if(depth>5)throw Error('tool nesting');
  if(typeof value==='string')return unpack(JSON.parse(value.replace(/^Output:\s*/i,'')),depth+1);
  if(Array.isArray(value)&&value.length&&value.every(item=>['text','input_text'].includes(item?.type)))
    return unpack(value.at(-1),depth+1);
  if(value?.content && !value.topics && !value.citation && !value.rows)return unpack(value.content,depth+1);
  if(value?.type==='text' || value?.type==='input_text')return unpack(value.text,depth+1);
  return value;
}
function lastToolOutput(body, id) {
  const outputs=(body.input||[]).filter(item=>item.type==='function_call_output'&&item.call_id===id);
  if(outputs.length!==1)throw Error('expected tool result missing');
  return unpack(outputs[0].output);
}
function sendResponse(res, index, item) {
  const response={id:'response_synthetic_'+index,object:'response',created_at:1767225600,
    status:'completed',model:'gpt-6-luna',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

async function providerRecall(configDir, catalog, instructions) {
  const token=process.env.MEMLAB_PROXY_TOKEN;
  if(typeof token!=='string'||!/^[a-zA-Z0-9_-]{24,128}$/.test(token))throw Error('proxy unavailable');
  const mcpArgs=[cliPath,'mcp','--dir',archive,'--owner','synthetic','--project','release'];
  const schemaPath='/work/recall-output-schema.json', answerPath='/work/recall-answer.json';
  const fields=['topic','decision','next_step','original_revision','correction_revision','original_quote','correction_quote'];
  const schema={type:'object',additionalProperties:false,required:fields,
    properties:Object.fromEntries(fields.map(field=>[field,{type:'string',maxLength:600}]))};
  await fs.writeFile(schemaPath,JSON.stringify(schema),{flag:'wx',mode:0o600});
  await fs.writeFile(join(configDir,'config.toml'),`
model_provider = "bounded"
model_catalog_json = ${JSON.stringify(catalog)}
model_instructions_file = ${JSON.stringify(instructions)}
[mcp_servers.memory]
command = "/usr/local/bin/node"
args = ${JSON.stringify(mcpArgs)}
required = true
enabled_tools = ${JSON.stringify([...new Set(steps)])}
default_tools_approval_mode = "approve"
[model_providers.bounded]
name = "bounded"
base_url = "http://172.28.88.2:8080/v1"
env_key = "MEMLAB_PROXY_TOKEN"
wire_api = "responses"
supports_websockets = false
`,{flag:'wx',mode:0o600});
  const args=['exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never',
    '-m','gpt-6-luna','-c','model_reasoning_effort="low"','-c','approval_policy="never"',
    '-c','web_search="disabled"','--disable','shell_tool','--disable','unified_exec','--disable','memories',
    '--disable','hooks','--output-schema',schemaPath,'--output-last-message',answerPath,
    'Find the current release plan and next action. Make exactly five tool calls. First use memory_find with keyword "release" and limit 5. Use memory_current and memory_timeline for the selected topic. Call memory_evidence once for each complete citation returned by memory_current, the original citation and effectiveCitation. Copy the reviewed decision and next step exactly, including the next step marker. Copy both evidence revisions and one contiguous quote of at least 18 characters from each exact evidence result.'];
  const cli=spawn('codex',args,{env:{...codexEnv(configDir),MEMLAB_PROXY_TOKEN:token},cwd:process.cwd(),
    detached:true,stdio:['ignore','pipe','ignore']});
  let stdout='';
  const stop=()=>{try{process.kill(-cli.pid,'SIGKILL');}catch{}};
  cli.stdout.on('data',b=>{stdout+=b;if(stdout.length>524288)stop();});
  const timer=setTimeout(stop,85000);
  const code=await new Promise((resolve,reject)=>{cli.on('error',reject);cli.on('close',resolve);})
    .finally(()=>clearTimeout(timer));
  const events=stdout.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  if(code!==0||!events.some(e=>e.type==='turn.completed')){
    console.log(JSON.stringify({harness:'codex',lane:'provider-backed',status:'blocked-provider-or-tool-run'}));
    process.exitCode=1;return;
  }
  const calls=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call'&&e.item.server==='memory'&&e.item.status==='completed').map(e=>e.item);
  try{
    const results=name=>calls.filter(call=>call.tool===name).map(call=>unpack(call.result));
    const findCall=calls.find(call=>call.tool==='memory_find'&&call.arguments?.keyword==='release'&&call.arguments?.limit===5);
    const found=findCall&&unpack(findCall.result);
    const reviewed=results('memory_current').flat().find(r=>r.topic===topic&&r.effectiveCitation?.revision&&r.citation?.revision!==r.effectiveCitation.revision);
    const evidence=results('memory_evidence');
    const original=evidence.find(r=>matchesCitation(r,reviewed?.citation)), corrected=evidence.find(r=>matchesCitation(r,reviewed?.effectiveCitation));
    const next=results('memory_timeline').flatMap(r=>r.rows||[]).find(r=>typeof r.next_step==='string'&&/MEMLAB_CANARY_[a-f0-9]{24}/.test(r.next_step));
    const answer=JSON.parse(await fs.readFile(answerPath,'utf8'));
    if(found?.topics?.length!==5||!found.coverage?.has_more||!found.topics.some(t=>t.topic===topic)||
      !reviewed||!original||!corrected||!next||answer.topic!==topic||
      answer.decision!==reviewed.text||answer.next_step!==next.next_step||
      answer.original_revision!==original.revision||answer.correction_revision!==corrected.revision||
      !matchesQuote(original,answer.original_quote)||!matchesQuote(corrected,answer.correction_quote))throw Error('acceptance');
    const turns=events.filter(e=>e.type==='turn.completed');
    const stats=Object.fromEntries(['input_tokens','cached_input_tokens','output_tokens']
      .filter(key=>Number.isSafeInteger(turns[0]?.usage?.[key])).map(key=>[key,turns[0].usage[key]]));
    console.log(JSON.stringify({harness:'codex',lane:'provider-backed',status:'validated',
      requestedModel:'gpt-6-luna',requestedEffort:'low',matchedMcpCalls:calls.length,
      archiveOnlyCanaryVerified:true,distinctEvidenceVersions:2,usage:stats}));
  }catch{
    console.log(JSON.stringify({harness:'codex',lane:'provider-backed',status:'failed-tool-or-citation-acceptance',matchedMcpCalls:calls.length}));
    process.exitCode=1;
  }
}

async function main() {
  await fs.access(cliPath);
  const configDir=join(homedir(),'.codex');
  await fs.mkdir(configDir,{recursive:true,mode:0o700});
  const catalog=await functionToolCatalog(configDir);
  const instructions=join(configDir,'fixture-instructions.txt');
  await fs.writeFile(instructions,'This is an isolated synthetic memory test. Use the read-only memory tools to retrieve and verify the requested facts. Use only their evidence when answering.\n',{flag:'wx',mode:0o600});
  if(process.env.MEMLAB_RECALL_MODE==='provider')return providerRecall(configDir,catalog,instructions);
  let index=0, rejected=false, gateReason, toolDescriptors=[], resultShape, current, original, corrected, final;
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.method!=='POST'||req.url!=='/v1/responses'||index>steps.length)throw Error('unexpected provider request');
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>262144)throw Error('request budget');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(index===0){
        toolDescriptors=(body.tools||[]).map(tool=>({type:tool.type,name:tool.name,nested:tool.tools?.map(t=>t.name)}));
      }
      if(body.model!=='gpt-6-luna'||body.reasoning?.effort!=='low'||!Array.isArray(body.input))throw Error('unexpected model configuration');
      if(index===0&&JSON.stringify(body.input).includes('MEMLAB_CANARY_'))throw Error('canary leaked into initial input');
      const result=index===0?null:lastToolOutput(body,'call_synthetic_'+(index-1));
      if(index>0)resultShape={type:typeof result,array:Array.isArray(result),keys:Object.keys(result||{}),
        isError:Boolean(result?.error || result?.isError),topicCount:result?.topics?.length};
      let args;
      if(index===0)args={keyword:'release',limit:5};
      if(index===1){
        if(!Array.isArray(result?.topics)||result.topics.length!==5||!result.coverage?.has_more||
          !result.topics.some(t=>t.topic===topic))throw Error('bounded topic discovery failed');
        args={topic};
      }
      if(index===2){
        if(!Array.isArray(result)||result.length!==1)throw Error('reviewed decision missing');
        [current]=result;
        if(typeof current.text!=='string'||!current.citation?.revision||!current.effectiveCitation?.revision||
          current.citation.revision===current.effectiveCitation.revision)throw Error('distinct correction source missing');
        args=current.citation;
      }
      if(index===3){
        original=result;
        if(typeof original?.text!=='string'||!matchesCitation(original,current.citation))throw Error('original evidence missing');
        args=current.effectiveCitation;
      }
      if(index===4){
        corrected=result;
        if(typeof corrected?.text!=='string'||!matchesCitation(corrected,current.effectiveCitation))throw Error('correction evidence missing');
        args={topic};
      }
      if(index===5){
        if(!Array.isArray(result?.rows))throw Error('timeline missing');
        const todo=result.rows.find(r=>typeof r.next_step==='string'&&/MEMLAB_CANARY_[a-f0-9]{24}/.test(r.next_step));
        if(!todo)throw Error('archive-only todo canary missing');
        final=[current.text,todo.next_step,original.revision,original.text.slice(0,100),
          corrected.revision,corrected.text.slice(0,100)].join('\n');
        sendResponse(res,index++,{id:'msg_synthetic_recall',type:'message',role:'assistant',status:'completed',
          content:[{type:'output_text',text:final,annotations:[]}]});return;
      }
      const namespace=body.tools?.find(tool=>tool.type==='namespace'&&tool.name==='mcp__memory');
      const nested=namespace?.tools?.find(tool=>tool.type==='function'&&tool.name===steps[index]);
      const fn=nested||body.tools?.find(t=>t.type==='function'&&(t.name===steps[index]||t.name.endsWith('__'+steps[index])));
      if(!fn)throw Error('actual memory tool not discovered');
      const item={id:'fc_synthetic_'+index,call_id:'call_synthetic_'+index,type:'function_call',
        name:fn.name,...(nested?{namespace:namespace.name}:{}),arguments:JSON.stringify(args),status:'completed'};
      sendResponse(res,index++,item);
    } catch(error) {
      rejected=true;
      const safe=['unexpected provider request','request budget','unexpected model configuration','canary leaked into initial input',
        'expected tool result missing','bounded topic discovery failed','reviewed decision missing','distinct correction source missing',
        'original evidence missing','correction evidence missing','timeline missing','archive-only todo canary missing','actual memory tool not discovered','tool nesting'];
      gateReason=safe.includes(error.message)?error.message:'fixture payload rejected';
      if(!res.headersSent){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"protocol replay gate rejected"}');}
      else res.destroy();
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const port=server.address().port;
    const mcpArgs=[cliPath,'mcp','--dir',archive,'--owner','synthetic','--project','release'];
    await fs.writeFile(join(configDir,'config.toml'),`
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(catalog)}
model_instructions_file = ${JSON.stringify(instructions)}
[mcp_servers.memory]
command = "/usr/local/bin/node"
args = ${JSON.stringify(mcpArgs)}
required = true
enabled_tools = ${JSON.stringify([...new Set(steps)])}
default_tools_approval_mode = "approve"
[model_providers.fixture]
name = "fixture"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "FIXTURE_KEY"
wire_api = "responses"
supports_websockets = false
`,{flag:'wx',mode:0o600});
    const args=['exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json','--color','never',
      '-m','gpt-6-luna','-c','model_reasoning_effort="low"','-c','approval_policy="never"',
      '-c','web_search="disabled"','--disable','shell_tool','--disable','unified_exec','--disable','memories',
      'Find the current release plan, the next action, and the original and later evidence.'];
    const env={...codexEnv(configDir),FIXTURE_KEY:'synthetic-not-a-credential'};
    const cli=spawn('codex',args,{env,
      cwd:process.cwd(),detached:true,stdio:['ignore','pipe','pipe']});
    let stdout='', stderr='';
    const stop=()=>{try{process.kill(-cli.pid,'SIGKILL');}catch{}};
    cli.stdout.on('data',b=>{stdout+=b;if(stdout.length>524288)stop();});
    cli.stderr.on('data',b=>{stderr+=b;if(stderr.length>16384)stop();});
    const timer=setTimeout(stop,55000);
    const code=await new Promise((resolve,reject)=>{cli.on('error',reject);cli.on('close',resolve);})
      .finally(()=>clearTimeout(timer));
    const events=stdout.trim().split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const called=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call'&&e.item?.status==='completed');
    if(code!==0||rejected||index!==steps.length+1||!final||
      called.length!==steps.length||called.some((e,i)=>e.item.tool!==steps[i])||
      !events.some(e=>e.type==='turn.completed')||
      !events.some(e=>e.type==='item.completed'&&e.item?.type==='agent_message'&&e.item.text===final))
      {
        const configured=spawnSync('codex',['mcp','list','--json'],{env,encoding:'utf8',timeout:4000,maxBuffer:8192});
        let configuredMemory=false;
        try{configuredMemory=JSON.parse(configured.stdout).some(server=>server.name==='memory'&&server.enabled);}catch{}
        console.log(JSON.stringify({harness:'codex',lane:'synthetic-protocol-replay',status:'blocked',providerStages:index,
          gateReason:gateReason||'CLI evidence gate',toolDescriptors,configuredMemory,resultShape,
          cliCallTypes:events.filter(e=>e.item&&e.item.type!=='agent_message').map(e=>({type:e.item.type,status:e.item.status,tool:e.item.tool})),
          mcpWarnings:events.flatMap(e=>[e.message,e.error?.message]).filter(message=>/\bMCP\b/i.test(message||'')).slice(0,3),
          startupWarnings:stderr.split('\n').filter(line=>/\bMCP\b|permission denied|module not found/i.test(line)).slice(0,3),
          completedMcpCalls:called.length,completedTurns:events.filter(e=>e.type==='turn.completed').length}));
        throw Error('recall replay did not complete with actual tools');
      }
    console.log(JSON.stringify({harness:'codex',lane:'synthetic-protocol-replay',nativeCli:true,
      matchedMcpCalls:called.length,archiveOnlyCanaryVerified:true,distinctEvidenceVersions:2,externalModelCalls:0}));
  } finally {server.close();}
}
main().catch(()=>{console.error('BLOCKED: real Codex CLI MCP replay did not satisfy the protocol gates.');process.exitCode=1;});
