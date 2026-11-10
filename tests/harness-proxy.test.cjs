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
