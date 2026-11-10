'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {createBudgetProxy,LIMITS}=require('../benchmark/harness-e2e/openai-proxy.cjs');
const token='synthetic-transport-token-for-test';
const body={model:'gpt-6-luna',reasoning:{effort:'low'},input:[{role:'user',content:'synthetic'}],stream:false};

test('trusted proxy binds model, effort, tool scope, credentials and request budget',async t=>{
 const calls=[];
 const server=createBudgetProxy({apiKey:'synthetic-upstream-key',gateToken:token,fetchImpl:async(url,options)=>{
  calls.push({url,headers:options.headers,body:JSON.parse(options.body),redirect:options.redirect});
  return new Response('data: '+JSON.stringify({type:'response.completed',response:{
   status:'completed',model:'gpt-6-luna',usage:{input_tokens:2,output_tokens:1,total_tokens:3}
  }})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(r=>server.close(r)));
 const root='http://127.0.0.1:'+server.address().port;
 const post=(value,auth=token,url='/v1/responses')=>fetch(root+url,{method:'POST',
  headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await post(body,'wrong')).status,401);
 assert.equal((await post(body,token,'/v1/chat/completions')).status,404);
 assert.equal((await post({...body,model:'other'})).status,400);
 assert.equal((await post({...body,reasoning:{effort:'high'}})).status,400);
 assert.equal((await post({...body,previous_response_id:'external-state'})).status,400);
 assert.equal((await post({...body,input:[{type:'input_image',image_url:'https://example.invalid'}]})).status,400);
 assert.equal((await post({...body,input:'MEMLAB_CANARY_0123456789abcdef01234567'})).status,400);
 assert.equal((await post({...body,tools:[{type:'web_search'}]})).status,400);
 assert.equal((await post({...body,tools:[{type:'function',name:'shell'}]})).status,400);
 assert.equal((await post({...body,tools:[{type:'namespace',name:'mcp__memory',tools:[{type:'function',name:'memory_annotate'}]}]})).status,400);
 assert.equal((await post({...body,input:'x'.repeat(LIMITS.requestBytes)})).status,413);
 assert.equal(calls.length,0);
 for(let i=0;i<LIMITS.requests;i++){
  const r=await post({...body,max_output_tokens:99999,store:true,tools:[
   {type:'namespace',name:'mcp__memory',tools:[{type:'function',name:'memory_evidence'}]},
   {type:'custom',name:'apply_patch'},{type:'function',name:'list_mcp_resources'}
  ]});
  assert.equal(r.status,200);
  await r.text();
 }
 assert.equal((await post(body)).status,429);
 assert.equal(calls.length,LIMITS.requests);
 const stats=await fetch(root+'/stats',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());
 assert.equal(stats.providerOk,LIMITS.requests);
 assert.equal(stats.terminalCompleted,LIMITS.requests);
 assert.deepEqual(stats.observedModels,['gpt-6-luna']);
 assert.deepEqual(stats.usage.total_tokens,{reported:LIMITS.requests,tokens:LIMITS.requests*3});
 for(const x of calls){
  assert.equal(x.url,'https://api.openai.com/v1/responses');
  assert.equal(x.redirect,'error');
  assert.equal(x.headers.authorization,'Bearer synthetic-upstream-key');
  assert.equal(x.body.max_output_tokens,LIMITS.outputTokens);
  assert.equal(x.body.store,false);
  assert.equal(x.body.model,'gpt-6-luna');
  assert.equal(x.body.reasoning.effort,'low');
  assert.deepEqual(x.body.tools,[{type:'namespace',name:'mcp__memory',tools:[{type:'function',name:'memory_evidence'}]}]);
 }
});

test('successful HTTP alone does not establish a completed model turn',async t=>{
 const responses=[
  Response.json({status:'incomplete',model:'gpt-6-luna'}),
  Response.json({status:'completed',model:'another-model'}),
  Response.json({status:'completed',model:'gpt-6-luna'})
 ];
 const server=createBudgetProxy({apiKey:'synthetic-upstream-key',gateToken:token,fetchImpl:async()=>responses.shift()});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const root='http://127.0.0.1:'+server.address().port;
 const authorization='Bearer '+token;
 for(let i=0;i<3;i++){
  const response=await fetch(root+'/v1/responses',{method:'POST',headers:{authorization,'content-type':'application/json'},
   body:JSON.stringify(body)});
  assert.equal(response.status,200);
  await response.text();
 }
 const stats=await fetch(root+'/stats',{headers:{authorization}}).then(response=>response.json());
 assert.equal(stats.providerOk,1);
 assert.equal(stats.providerFailed,2);
 assert.equal(stats.missingTerminal,1);
 assert.equal(stats.unexpectedModel,1);
 assert.deepEqual(stats.usage.input_tokens,{reported:0,tokens:null});
});

test('preserves bounded tool choices and the Responses function-call wire shape',async t=>{
 const sent=[];
 const {createBoundedFind}=require('../lib/generated/bounded-memory-find.cjs');
 const facade=createBoundedFind(()=>assert.fail('invalid find reached lookup'),()=>{});
 const find={type:'function',name:'memory_find',description:facade.description,parameters:facade.inputSchema,strict:false};
 const findArgs={limit:facade.inputSchema.properties.limit.maximum+1};
 const firstOutput=[
  {type:'reasoning',id:'rs_fixture',summary:[]},
  {type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'memory_find',arguments:JSON.stringify(findArgs),status:'completed'}
 ];
 const reply=await facade.run(findArgs);
 assert.equal(reply.error?.code,'limit-maximum');
 const result={type:'function_call_output',call_id:'call_fixture',output:JSON.stringify(reply)};
 const schema={type:'object',properties:{status:{type:'string',enum:['found','unknown']}},
  required:['status'],additionalProperties:false};
 const server=createBudgetProxy({apiKey:'synthetic-upstream-key',gateToken:token,fetchImpl:async(_url,options)=>{
  sent.push(JSON.parse(options.body));
  return Response.json({status:'completed',model:'gpt-6-luna',reasoning:{effort:'low'},
   output:sent.length===1?firstOutput:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"status":"unknown"}'}]}]});
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const root='http://127.0.0.1:'+server.address().port,authorization='Bearer '+token;
 const post=value=>fetch(root+'/v1/responses',{method:'POST',
  headers:{authorization,'content-type':'application/json'},body:JSON.stringify(value)});
 for(const choice of [
  {type:'web_search'}, {type:'function',name:'list_mcp_resources'},
  {type:'function',name:'memory_evidence'}, {type:'function',name:'memory_find',namespace:'foreign'},
  {type:'allowed_tools',mode:'auto',tools:[{type:'function',name:'memory_find'}]}, null, 'unsupported',
 ]){
  const response=await post({...body,tools:[find,{type:'function',name:'list_mcp_resources'}],tool_choice:choice});
  assert.equal(response.status,400);
  assert.equal((await response.json()).code,'tool-choice-rejected');
 }
 const noTools=await post({...body,tools:[{type:'function',name:'list_mcp_resources'}],tool_choice:'required'});
 assert.equal(noTools.status,400);
 assert.equal((await noTools.json()).code,'tool-choice-rejected');
 assert.equal(sent.length,0);
 const choice={type:'function',name:'memory_find'};
 const instructions='Synthetic instructions forwarding sentinel.';
 const initial=await post({...body,instructions,parallel_tool_calls:true,tools:[find],tool_choice:choice});
 assert.equal(initial.status,200);
 assert.deepEqual((await initial.json()).output,firstOutput);
 assert.deepEqual(sent[0].tool_choice,choice);
 assert.deepEqual(sent[0].input,body.input);
 assert.equal(sent[0].instructions,instructions);
 assert.equal(sent[0].parallel_tool_calls,true);
 assert.equal(sent[0].text,undefined);
 const continuation=await post({...body,input:[...body.input,...firstOutput,result],
  instructions,parallel_tool_calls:false,text:{format:{type:'json_schema',name:'recall_status',strict:true,schema}},tool_choice:'none'});
 assert.equal(continuation.status,200);
 await continuation.json();
 assert.deepEqual(sent[1].input.at(-1),result);
 assert.equal(sent[1].input.at(-2).call_id,result.call_id);
 assert.deepEqual(sent[1].text.format.schema,schema);
 assert.equal(sent[1].tool_choice,'none');
 assert.equal(sent[1].instructions,instructions);
 assert.equal(sent[1].parallel_tool_calls,false);
 for(const mode of ['auto','required']){
  const response=await post({...body,tools:[{type:'namespace',name:'mcp__memory',tools:[find]}],tool_choice:mode});
  assert.equal(response.status,200);
  await response.json();
  assert.equal(sent.at(-1).tool_choice,mode);
  assert.equal(sent.at(-1).parallel_tool_calls,false);
 }
 const stats=await fetch(root+'/stats',{headers:{authorization}}).then(r=>r.json());
 assert.equal(stats.toolChoiceRejections,8);
 assert.equal(stats.requests,4);
});

test('records a completed SSE event before the client closes an open stream',async t=>{
 const terminal=Buffer.from('data: '+JSON.stringify({type:'response.completed',response:{
  status:'completed',model:'gpt-6-luna',reasoning:{effort:'low'},usage:{input_tokens:7,output_tokens:2,total_tokens:9}
 }})+'\n\n');
 let upstreamAborted;
 const aborted=new Promise(resolve=>{upstreamAborted=resolve;});
 const server=createBudgetProxy({apiKey:'synthetic-upstream-key',gateToken:token,fetchImpl:async(_url,{signal})=>
  new Response(new ReadableStream({start(controller){
   controller.enqueue(terminal.subarray(0,20));
   controller.enqueue(terminal.subarray(20));
   signal.addEventListener('abort',()=>{controller.error(Error('downstream closed'));upstreamAborted();},{once:true});
  }}),{headers:{'content-type':'text/event-stream'}})
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const root='http://127.0.0.1:'+server.address().port,authorization='Bearer '+token;
 const response=await fetch(root+'/v1/responses',{method:'POST',headers:{authorization,'content-type':'application/json'},
  body:JSON.stringify({...body,stream:true})});
 const reader=response.body.getReader();
 let received=0;
 while(received<terminal.length){
  const part=await reader.read();
  assert.equal(part.done,false);
  received+=part.value.length;
 }
 await reader.cancel();
 await aborted;
 const stats=await fetch(root+'/stats',{headers:{authorization}}).then(r=>r.json());
 assert.equal(stats.providerOk,1);
 assert.equal(stats.providerFailed,0);
 assert.equal(stats.effortConfirmed,1);
 assert.deepEqual(stats.usage.total_tokens,{reported:1,tokens:9});
});
