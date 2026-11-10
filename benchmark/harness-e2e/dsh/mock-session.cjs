'use strict';
// Public offline smoke: genuine DSH, synthetic provider, disposable profile.
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const dsh='/opt/dsh-test/node_modules/.bin/dsh', expected='SYNTHETIC_DSH_RESPONSE';
function run(args,env,ms=30000){return new Promise(resolve=>{let out='',done=false,expired=false;const p=spawn(dsh,args,{env,cwd:env.DSH_HOME,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{expired=true;p.kill('SIGKILL');},ms);const end=code=>{if(done)return;done=true;clearTimeout(timer);resolve({code,out,expired});};p.stdout.on('data',b=>{out=(out+b).slice(0,1048576);});p.stderr.resume();p.on('error',()=>end(null));p.on('close',end);});}
(async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-dsh-'));
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,DSH_HOME:home,DSH_TELEMETRY_MODE:'OFF',LANG:'C.UTF-8',DEEPSEEK_API_KEY:'synthetic-key'};
 const v=await run(['--version'],env),h=await run(['headless','--help'],env);
 if(v.code!==0||v.out.trim()!=='0.2.2-rc.1'||h.code!==0||!h.out.includes('--json'))throw Error();
 let requests=0;
 const server=http.createServer((req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/messages'||requests>=8){res.writeHead(404).end();return;}
  requests++;let size=0;req.on('data',b=>{size+=b.length;if(size>1048576)req.destroy();});req.on('end',()=>{
   const events=[{type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:1,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:expected}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end('data: [DONE]\n\n');
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${server.address().port}/v1`;
 const prompts=[
  'Synthetic planning record: the Tuesday noon rehearsal is the agreed plan. The next step is to prepare the rehearsal checklist. Acknowledge this plan in one sentence.',
  'Synthetic correction record: the earlier Tuesday noon decision was about the rehearsal, not the production release. This corrects an interpretation; it does not change the rehearsal decision. Acknowledge in one sentence.'
 ];
 try {for (let i=0;i<prompts.length;i++) {
  const result=await run(['headless','--json','--permission-mode','read-only','--approval-policy','never',prompts[i]],env);
  if(result.code!==0||result.expired||!requests||!result.out.includes(expected))throw Error();
  await fs.writeFile(`/out/events-${i+1}.jsonl`,result.out,{mode:0o600});
 }} finally {await new Promise(resolve=>server.close(resolve));}
 await fs.cp(path.join(home,'sessions'),'/out/sessions',{recursive:true});
 console.log(JSON.stringify({harness:'dsh',version:'0.2.2-rc.1',synthetic:true,providerRequests:requests,sourceTurns:2,completed:true}));
})().catch(()=>{console.error(JSON.stringify({harness:'dsh',synthetic:true,completed:false,reason:'invocation-failed'}));process.exitCode=1;});
