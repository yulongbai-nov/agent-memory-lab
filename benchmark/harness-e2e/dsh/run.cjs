'use strict';
// Disposable source session generation. Network policy must permit only the
// caller-operated synthetic gate at 172.28.88.2:8080; never mount credentials.
const fs = require('node:fs/promises');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {tmpdir} = require('node:os');
const DSH='/opt/dsh-test/node_modules/.bin/dsh';
const PATCH='/opt/dsh-test/provider.patch.yml';
function command(args,env,timeout=90000) {
 return new Promise(resolve=>{
  const p=spawn(DSH,args,{env,cwd:env.DSH_HOME,stdio:['ignore','pipe','pipe']});
  let out='',err='',expired=false,done=false;
  const finish=code=>{if(done)return;done=true;clearTimeout(timer);resolve({code,expired,out,err});};
  const timer=setTimeout(()=>{expired=true;p.kill('SIGKILL');},timeout);
  p.stdout.on('data',b=>{out=(out+b).slice(0,1024*1024);});
  p.stderr.on('data',b=>{err=(err+b).slice(0,65536);});
  p.on('error',()=>finish(null));p.on('close',finish);
 });
}
async function main(){
 const token=process.env.MEMLAB_PROXY_TOKEN;
 if(typeof token!=='string' || !token.trim()) throw Error('Proxy gate token required');
 const ready=await fetch('http://172.28.88.2:8080/stats',{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
 if(!ready.ok) throw Error('Proxy unavailable');
 const stats=await ready.json();
 if(stats.requestedModel!=='gpt-6-luna' || stats.requestedEffort!=='low' || !stats.limits || typeof stats.limits!=='object') throw Error('Proxy configuration mismatch');
 const home=await fs.mkdtemp(path.join(tmpdir(),'synthetic-dsh-'));
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,DSH_HOME:home,DSH_TELEMETRY_MODE:'OFF',LANG:'C.UTF-8',OPENAI_API_KEY:token};
 const patch=await fs.readFile(PATCH,'utf8');
 if (!patch.includes('baseURL: http://172.28.88.2:8080/v1') || /https?:\/\/(?!172\.28\.88\.2:8080\/v1)/.test(patch)) throw Error('Unexpected provider configuration');
 const v=await command(['--version'],env), help=await command(['headless','--help'],env);
 if(v.code!==0 || v.out.trim()!=='0.2.2-rc.1' || help.code!==0 || !help.out.includes('--json')) throw Error('CLI version or help failed');
 const prompts=[
  'Synthetic planning record: the Tuesday noon rehearsal is the agreed plan. The next step is to prepare the rehearsal checklist. Acknowledge this plan in one sentence.',
  'Synthetic correction record: the earlier Tuesday noon decision was about the rehearsal, not the production release. This corrects an interpretation; it does not change the rehearsal decision. Acknowledge in one sentence.'
 ];
 for(let i=0;i<prompts.length;i++) {
  const run=await command(['--profile','headless','--patch',PATCH,'--json','--permission-mode','read-only','--approval-policy','never',prompts[i]],env);
  if(run.code!==0 || run.expired || !run.out.trim()) throw Error('Provider-backed source turn failed');
  await fs.writeFile(`/out/events-${i+1}.jsonl`,run.out,{mode:0o600});
 }
 await fs.cp(path.join(home,'sessions'),'/out/sessions',{recursive:true});
 console.log(JSON.stringify({harness:'dsh',version:'0.2.2-rc.1',sourceTurns:2,completed:true}));
}
main().catch(()=>{console.error(JSON.stringify({harness:'dsh',completed:false,reason:'source-turn-failed'}));process.exitCode=1;});
