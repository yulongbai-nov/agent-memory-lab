'use strict';

const { createServer } = require('node:http');
const { timingSafeEqual,createHash } = require('node:crypto');
const { once } = require('node:events');
const { constants, closeSync, fstatSync, openSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { safeMetadata } = require('./response-metadata.cjs');

const MODEL = 'gpt-6-luna';
const EFFORT = 'low';
const UPSTREAM = 'https://api.openai.com/v1/responses';
const LIMITS = Object.freeze({requests:16,requestBytes:65536,totalBytes:393216,outputTokens:512,
  responseBytes:524288,requestMs:75000,runMs:360000});
const toolName = /^(?:mcp__memory__)?memory_(find|timeline|current|evidence|coverage)$/;
const unsafeInput = /^(?:input_image|input_file|image_url|file_url|file_id|input_audio|audio_url|computer_call|web_search_call)$/;
const localFunctions = new Set(['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource',
  'request_user_input','request_user_input_async','view_image','get_goal','create_goal','update_goal']);

function constantEqual(value, expected) {
  const a = Buffer.from(value || ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a,b);
}
function safeInput(value, depth=0) {
  if (depth > 32) return false;
  if (Array.isArray(value)) return value.every(item=>safeInput(item,depth+1));
  if (value && typeof value === 'object') {
    if (unsafeInput.test(value.type || '')) return false;
    return Object.entries(value).every(([key,item])=>!unsafeInput.test(key) && safeInput(item,depth+1));
  }
  return true;
}
function canaryWasRetrieved(input) {
  if (typeof input === 'string') return !input.includes('MEMLAB_CANARY_');
  const retrieved = new Set();
  for (const item of input) {
    const matches = JSON.stringify(item)?.match(/MEMLAB_CANARY_[a-f0-9]{24}/g) || [];
    if (item?.type === 'function_call_output') matches.forEach(match=>retrieved.add(match));
    else if (matches.some(match=>!retrieved.has(match))) return false;
  }
  return true;
}
function memoryTools(tools) {
  if (!Array.isArray(tools)) throw Error('tool rejected');
  const memory = [];
  let count=0;
  for (const tool of tools) {
    const readOnly = entry=>entry?.type==='function' && toolName.test(entry.name||'');
    if (readOnly(tool)) {memory.push(tool);count++;continue;}
    if (tool?.type==='namespace' && tool.name==='mcp__memory' &&
        Array.isArray(tool.tools) && tool.tools.every(readOnly)) {
      memory.push(tool);count+=tool.tools.length;continue;
    }
    // These tools are offered by the pinned CLI. They stay local and are
    // never advertised to the upstream model.
    if (tool?.type==='function' && localFunctions.has(tool.name) ||
        tool?.type==='custom' && tool.name==='apply_patch' ||
        tool?.type==='namespace' && ['clock','collaboration'].includes(tool.name)) continue;
    throw Error('tool rejected');
  }
  if (count>5) throw Error('tool rejected');
  return memory;
}
function memoryToolChoice(choice, tools = []) {
  if (choice === 'auto' || choice === 'none') return choice;
  if (choice === 'required' && tools.some(tool=>tool.type==='function'||tool.tools?.length)) return choice;
  if (choice?.type === 'function' && typeof choice.name === 'string' &&
      Object.keys(choice).length === 2 && Object.hasOwn(choice,'type') && Object.hasOwn(choice,'name') &&
      tools.some(tool=>tool.type==='function' && tool.name===choice.name)) {
    return {type:'function',name:choice.name};
  }
  // Only documented modes and explicitly declared flat memory functions
  // are supported. Do not silently translate unsupported choices to auto.
  throw Object.assign(new Error('tool choice rejected'),{code:'tool-choice-rejected'});
}
function buildRequest(body, outputTokens=LIMITS.outputTokens) {
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > LIMITS.outputTokens) throw Error('invalid output budget');
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== MODEL ||
      body.reasoning?.effort !== EFFORT || (typeof body.input !== 'string' && !Array.isArray(body.input)) ||
      body.previous_response_id || body.conversation || !safeInput(body.input) ||
      !canaryWasRetrieved(body.input)) throw Error('request rejected');
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw Error('instructions rejected');
  const allowed = {};
  for (const field of ['input','instructions','text']) {
    if (Object.hasOwn(body,field)) allowed[field] = body[field];
  }
  if (body.tools !== undefined) allowed.tools=memoryTools(body.tools);
  if (Object.hasOwn(body,'tool_choice')) allowed.tool_choice=memoryToolChoice(body.tool_choice,allowed.tools);
  if (Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content')) {
    allowed.include = ['reasoning.encrypted_content'];
  }
  return {...allowed,model:MODEL,reasoning:{effort:EFFORT},store:false,
    max_output_tokens:outputTokens,parallel_tool_calls:body.parallel_tool_calls===true,stream:body.stream===true};
}

function readBody(req, limit) {
  return new Promise((resolve,reject)=>{
    const chunks=[]; let bytes=0,settled=false;
    const fail=()=>{ if (!settled){settled=true;reject(Error('body rejected'));} };
    req.on('data',part=>{
      bytes+=part.length;
      if(bytes>limit)fail();
      if(!settled)chunks.push(part);
    });
    req.on('error',fail);
    req.on('end',()=>{if(!settled){settled=true;resolve({bytes,text:Buffer.concat(chunks).toString('utf8')});}});
  });
}
async function providerError(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > 16384 || !response.body) return;
  let size=0;
  const chunks=[];
  try {
    for await (const part of response.body) {
      size+=part.length;
      if(size>16384)return;
      chunks.push(part);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {}
}
function responseSnapshots(body, contentType) {
  const terminal = new Set(['completed','incomplete','failed','cancelled']);
  if (contentType.startsWith('application/json')) {
    try { const result=JSON.parse(body); return result && typeof result==='object' && (terminal.has(result.status)||result.usage) ? [{response:result,terminal:terminal.has(result.status)}] : []; } catch { return []; }
  }
  const found=[];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:') || !line.slice(5).trimStart().startsWith('{')) continue;
    try {
      const event=JSON.parse(line.slice(5));
      if (typeof event.type==='string' && event.type.startsWith('response.') && event.response && (terminal.has(event.response.status)||event.response.usage)) found.push({response:event.response,terminal:terminal.has(event.response.status)&&event.type===`response.${event.response.status}`});
    } catch {}
  }
  return found;
}

function createBudgetProxy({apiKey,gateToken,fetchImpl=fetch,requestLimit=LIMITS.requests,outputTokens=LIMITS.outputTokens}) {
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > LIMITS.requests || !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > LIMITS.outputTokens) throw Error('invalid proxy budget');
  const limits = {...LIMITS,requests:requestLimit,outputTokens};
  if (typeof apiKey!=='string' || !apiKey.trim() || typeof gateToken!=='string' ||
      !/^[a-zA-Z0-9_-]{24,128}$/.test(gateToken)) throw Error('proxy credentials unavailable');
  const stats={requests:0,inputBytes:0,providerOk:0,providerFailed:0,authFailures:0,rateLimits:0,
    modelUnavailable:0,providerRejections:0,gateRejections:0,toolChoiceRejections:0,budgetRefusals:0,deadlineRefusals:0,
    terminalCompleted:0,terminalIncomplete:0,terminalFailed:0,terminalCancelled:0,missingTerminal:0,missingModel:0,unexpectedModel:0,
    effortConfirmed:0,effortUnreported:0,unexpectedEffort:0,
    clientClosedBeforeTerminal:0,transportFailures:0};
  const models=new Set();
  const wireHashes=[];
  const usage=Object.fromEntries(['input_tokens','output_tokens','total_tokens'].map(key=>[key,{reported:0,tokens:0}]));
  let deadline;
  const server=createServer(async(req,res)=>{
    const send=(code,body)=>{
      res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));
    };
    if(!constantEqual(req.headers.authorization,'Bearer '+gateToken))return send(401,{error:'denied'});
    if(req.method==='GET'&&req.url==='/stats')return send(200,{...stats,observedModels:[...models],
      usage:Object.fromEntries(Object.entries(usage).map(([key,value])=>[key,
        {...value,tokens:value.reported ? value.tokens : null}])),
      requestedModel:MODEL,requestedEffort:EFFORT,wireHashVersion:1,wireHashes:[...wireHashes],limits});
    if(req.method!=='POST'||req.url!=='/v1/responses')return send(404,{error:'unsupported'});
    if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(415,{error:'unsupported body'});
    if(Number(req.headers['content-length'])>LIMITS.requestBytes)return send(413,{error:'input limit'});
    let incoming,outbound;
    try{incoming=await readBody(req,LIMITS.requestBytes);}
    catch{return send(413,{error:'input limit'});}
    try{outbound=buildRequest(JSON.parse(incoming.text),outputTokens);}
    catch(error){
      stats.gateRejections++;
      if(error.code==='tool-choice-rejected'){
        stats.toolChoiceRejections++;
        return send(400,{error:'tool choice rejected by the fixture proxy',code:error.code});
      }
      return send(400,{error:'request rejected by the fixture proxy'});
    }
    const data=JSON.stringify(outbound), bytes=Buffer.byteLength(data);
    if(bytes>LIMITS.requestBytes)return send(413,{error:'input limit'});
    if(stats.requests>=requestLimit||stats.inputBytes+bytes>LIMITS.totalBytes){
      stats.budgetRefusals++;return send(429,{error:'budget-exhausted'});
    }
    const now=Date.now();
    deadline ??= now+LIMITS.runMs;
    if(now>=deadline){stats.deadlineRefusals++;return send(429,{error:'deadline-exhausted'});}
    stats.requests++;stats.inputBytes+=bytes;wireHashes.push(createHash('sha256').update(data,'utf8').digest('hex'));
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),Math.min(LIMITS.requestMs,deadline-now));
    res.on('close',()=>controller.abort());
    let terminalObserved=false;
    const usageSeen=new Map();
    const countUsage=record=>{
      for(const [key,value] of Object.entries(usage)) {
        const tokens=record?.usage?.[key];
        if(Number.isSafeInteger(tokens)&&tokens>=0){
          if(!usageSeen.has(key)){usageSeen.set(key,tokens);value.reported++;value.tokens+=tokens;}
          else {value.tokens+=tokens-usageSeen.get(key);usageSeen.set(key,tokens);}
        }
      }
    };
    const observeTerminal=snapshot=>{
      const completed=snapshot?.response;
      if(!completed || (terminalObserved && !snapshot.terminal))return;
      countUsage(completed);
      if(!snapshot.terminal)return;
      if(terminalObserved)return;
      terminalObserved=true;
      if(completed.status!=='completed'){
        if(completed.status==='incomplete')stats.terminalIncomplete++;
        else if(completed.status==='failed')stats.terminalFailed++;
        else if(completed.status==='cancelled')stats.terminalCancelled++;
        stats.providerFailed++;
        return;
      }
      stats.terminalCompleted++;
      if(typeof completed.model!=='string'){stats.missingModel++;stats.providerFailed++;}
      else if(!/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(completed.model)){
        stats.unexpectedModel++;stats.providerFailed++;
      } else if(completed.reasoning?.effort!=null&&completed.reasoning.effort!==EFFORT){
        stats.unexpectedEffort++;stats.providerFailed++;
      } else {
        if(completed.reasoning?.effort===EFFORT)stats.effortConfirmed++;
        else stats.effortUnreported++;
        models.add(completed.model);
        stats.providerOk++;
      }
    };
    try{
      const upstream=await fetchImpl(UPSTREAM,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:data});
      if(!upstream.ok||!upstream.body){
        stats.providerFailed++;
        const failure=upstream.body ? await providerError(upstream) : null;
        countUsage(failure?.response ?? failure);
        if(upstream.status===401||upstream.status===403)stats.authFailures++;
        else if(upstream.status===429)stats.rateLimits++;
        else if([400,404,422].includes(upstream.status)){
          if(failure?.error?.code==='model_not_found')stats.modelUnavailable++;
          else stats.providerRejections++;
        }
        if(!upstream.bodyUsed)await upstream.body?.cancel();
        return send(502,{error:'provider failed',provider: safeMetadata(failure?.response ?? failure)});
      }
      const type=upstream.headers.get('content-type')||'';
      if(!/^application\/json\b|^text\/event-stream\b/.test(type)){stats.providerFailed++;await upstream.body.cancel();return send(502,{error:'provider format rejected'});}
      res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
      let received=0;
      let pending='';
      const decoder=new StringDecoder('utf8');
      for await(const part of upstream.body){
        received+=part.length;
        if(received>LIMITS.responseBytes)throw Error('response limit');
        {
          pending+=decoder.write(part);
          if(type.startsWith('text/event-stream')){
            const lastLine=pending.lastIndexOf('\n');
            if(lastLine>=0){
              // Codex can close the downstream connection as soon as this
              // event arrives, before the upstream transport reaches EOF.
              responseSnapshots(pending.slice(0,lastLine+1),type).forEach(observeTerminal);
              pending=pending.slice(lastLine+1);
            }
          }
        }
        if(res.destroyed)throw Error('client closed');
        if(!res.write(part)&&!res.destroyed)await Promise.race([once(res,'drain'),once(res,'close')]);
        if(res.destroyed)throw Error('client closed');
      }
      responseSnapshots(pending+decoder.end(),type).forEach(observeTerminal);
      if(!terminalObserved){stats.missingTerminal++;stats.providerFailed++;}
      res.end();
    }catch{
      if(!terminalObserved){
        stats.providerFailed++;
        if(res.destroyed)stats.clientClosedBeforeTerminal++;
        else stats.transportFailures++;
      }
      if(!res.headersSent&&!res.destroyed)send(502,{error:'provider failed'});else res.destroy();
    }finally{clearTimeout(timer);}
  });
  server.headersTimeout=5000;
  server.requestTimeout=6000;
  return server;
}

function loadLocalKey() {
  const path = join(homedir(), '.local/share/agent-memory-lab/credentials/openai.env');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 ||
        stat.size > 4096) throw Error('invalid credentials file');
    const match = /^OPENAI_API_KEY=([a-zA-Z0-9_-]+)\r?\n?$/.exec(readFileSync(fd, 'utf8'));
    if (!match) throw Error('invalid credentials file');
    return match[1];
  } finally {
    closeSync(fd);
  }
}

if(require.main===module){
  try{
    const local = process.argv[2] === '--local-env-file';
    if(process.argv.length !== (local ? 3 : 2))throw Error('invalid proxy mode');
    const address=process.env.MEMLAB_PROXY_HOST || '127.0.0.1';
    if(!['127.0.0.1','172.28.88.2'].includes(address)||local&&address!=='127.0.0.1')throw Error('invalid proxy bind');
    const apiKey = local ? loadLocalKey() : process.env.MEMORY_LUNA_API_KEY;
    const server=createBudgetProxy({apiKey,gateToken:process.env.MEMLAB_PROXY_TOKEN});
    server.listen(8080,address,()=>console.log('Protected Responses proxy ready.'));
  }catch{console.log('BLOCKED: protected Responses proxy configuration unavailable.');process.exitCode=3;}
}

module.exports={createBudgetProxy,buildRequest,LIMITS};
