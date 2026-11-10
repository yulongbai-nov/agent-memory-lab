'use strict';
// Synthetic protocol fixture. This is not a model call or model E2E.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const home=fs.mkdtempSync('/tmp/codex-test-'); fs.mkdirSync(home,{recursive:true,mode:0o700});
let calls=0;
const server=http.createServer((req,res)=>{
 if (req.method!=='POST' || req.url!=='/v1/responses' || ++calls!==1) {res.writeHead(404);return res.end();}
 let n=0;req.on('data',b=>{n+=b.length;if(n>262144)req.destroy();});
 req.on('end',()=>{
  const msg={id:'msg_synthetic',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic response: the plan is Tuesday.',annotations:[]}]};
  const response={id:'resp_synthetic',object:'response',created_at:1767225600,status:'completed',model:'gpt-6-luna',output:[msg],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item:msg},{type:'response.completed',response}]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
 });
});
server.listen(0,'127.0.0.1',()=>{
 const port=server.address().port;
 fs.writeFileSync(path.join(home,'config.toml'),`model_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "FIXTURE_KEY"\nwire_api = "responses"\n`,{mode:0o600});
 const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:home,FIXTURE_KEY:'synthetic-not-a-credential'};
 const args=['exec','--skip-git-repo-check','--json','--color','never','-m','gpt-6-luna','-c','model_reasoning_effort="low"','Reply with the synthetic fixture answer.'];
 const cli=spawn('codex',args,{env,cwd:process.cwd(),detached:true,stdio:['ignore','pipe','pipe']}); let out='',err='';
 cli.stdout.on('data',b=>{out+=b;if(out.length>262144)cli.kill('SIGKILL');}); cli.stderr.on('data',b=>{err+=b;if(err.length>262144)cli.kill('SIGKILL');});
 const timer=setTimeout(()=>{try{process.kill(-cli.pid,'SIGKILL');}catch{}},30000);
 cli.on('close',code=>{clearTimeout(timer);server.close(); if(code!==0 || calls!==1){console.error('BLOCKED: mock protocol did not complete ('+String(code)+', calls '+calls+')'); if(process.env.DEBUG_SYNTHETIC==='1') console.error(err.slice(0,4000));process.exitCode=1;return;}
  const events=out.trim().split('\n').map(line=>JSON.parse(line));
  if (!events.some(event=>event.type==='turn.completed') || !events.some(event=>event.type==='item.completed' && event.item?.type==='agent_message' && event.item?.text==='Synthetic response: the plan is Tuesday.')) {console.error('BLOCKED: missing assistant message or completed turn');process.exitCode=1;return;}
  const sessions=path.join(home,'sessions');
  function scan(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?scan(path.join(d,e.name)):(e.name.endsWith('.jsonl')?[path.join(d,e.name)]:[]));}
  const files=scan(sessions); if(files.length!==1){console.error('BLOCKED: synthetic session was not captured');process.exitCode=1;return;}
  fs.copyFileSync(files[0],path.join(process.env.FIXTURE_OUT || '/out','codex-session.jsonl')); console.log('PASS: Codex synthetic protocol session captured (no model call)');
 });
});
