'use strict';
// Opt-in only. This module never downloads models or runs a network service.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {openStorage} = require('./storage.cjs');
const MODEL = path.join(os.homedir(),'models','Qwen3.5-4B-Q4_K_M.gguf');
const EXPECTED_SIZE = 2740937888;
const LLAMA = '/opt/homebrew/bin/llama-completion';
const SANDBOX = '/usr/bin/sandbox-exec';
const PROFILE = '(version 1)(allow default)(deny network*)(deny file-write*)';
const prepared = new Map();
function failure(code, stats) { const e = new Error('Local model operation failed'); e.code=code; e.safeLocal=true; if (stats) e.stats=stats; return e; }
async function prepareLocalModel() {
  try {
    if (process.platform !== 'darwin') throw failure('LOCAL_UNSUPPORTED');
    const st = await fsp.lstat(MODEL);
    if (!st.isFile() || st.isSymbolicLink() || st.size !== EXPECTED_SIZE) throw failure('MODEL_INVALID');
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(MODEL)) digest.update(chunk);
    const after=await fsp.lstat(MODEL);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== st.size || after.ino !== st.ino || after.dev !== st.dev || after.mtimeMs !== st.mtimeMs) throw failure('MODEL_CHANGED');
    const fingerprint=`sha256:${digest.digest('hex')}`;
    prepared.set(fingerprint,{ino:st.ino,dev:st.dev,size:st.size,mtimeMs:st.mtimeMs});
    return {path:MODEL,fingerprint};
  } catch (e) { throw e.safeLocal ? e : failure('MODEL_UNAVAILABLE'); }
}
function command(exe,args,{timeout=5000,env}={}) {
  return new Promise(resolve=>{
    let child, out='', err='', timer, settled=false;
    const finish=(code,signal)=>{ if (settled) return; settled=true; clearTimeout(timer); resolve({code,signal,out,err}); };
    try { child=spawn(exe,args,{env,stdio:['ignore','pipe','pipe']}); }
    catch { return finish(null,'spawn'); }
    child.stdout.on('data',b=>{out=(out+b.toString()).slice(0,8192);});
    child.stderr.on('data',b=>{err=(err+b.toString()).slice(0,8192);});
    child.on('error',()=>finish(null,'spawn')); child.on('close',finish);
    timer=setTimeout(()=>{child.kill('SIGKILL');},timeout);
  });
}
async function memoryFree() {
  const result=await command('/usr/bin/memory_pressure',['-Q'],{timeout:4000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
  if (result.code !== 0) throw failure('MEMORY_UNAVAILABLE');
  const match=/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i.exec(result.out);
  if (!match) throw failure('MEMORY_UNAVAILABLE');
  return Number(match[1]);
}
async function verifySandbox(env, profile, allowed, forbidden) {
  // Socket connect performs no payload transmission. Only EPERM/EACCES prove policy denial.
  const probe = `
import socket, errno, sys
with open(sys.argv[1], 'rb') as f:
    if not f.read(1):
        sys.exit(3)
try:
    with open(sys.argv[2], 'rb'):
        sys.exit(4)
except OSError as e:
    if e.errno not in (errno.EPERM, errno.EACCES):
        sys.exit(5)
for kind, addr in [(socket.SOCK_DGRAM, ('192.0.2.1', 9)), (socket.SOCK_STREAM, ('127.0.0.1', 1))]:
    try:
        with socket.socket(socket.AF_INET, kind) as s:
            s.settimeout(2)
            s.connect(addr)
        sys.exit(1)
    except OSError as e:
        if e.errno not in (errno.EPERM, errno.EACCES):
            sys.exit(2)
sys.exit(0)
`;
  const check=await command(SANDBOX,['-p',profile,'/usr/bin/env','python3','-c',probe,allowed,forbidden],{timeout:6000,env});
  if (check.code !== 0) throw failure('SANDBOX_UNVERIFIED');
}
async function runLocalLlama({model,prompt,schema,archiveDir} = {}) {
  let temp, canaryDir, child, reason, peak=0, started=Date.now();
  try {
    if (process.platform !== 'darwin') throw failure('LOCAL_UNSUPPORTED');
    if (!model || model.path !== MODEL || !prepared.has(model.fingerprint)) throw failure('MODEL_NOT_PREPARED');
    const expected=prepared.get(model.fingerprint), st=await fsp.lstat(MODEL);
    if (!st.isFile() || st.isSymbolicLink() || st.size!==expected.size || st.ino!==expected.ino || st.dev!==expected.dev || st.mtimeMs!==expected.mtimeMs) throw failure('MODEL_CHANGED');
    if (typeof prompt !== 'string' || Buffer.byteLength(prompt)>1500 || !schema || typeof schema !== 'object' || Array.isArray(schema)) throw failure('INVALID_INPUT');
    const schemaText=JSON.stringify(schema); if (Buffer.byteLength(schemaText)>1024*1024) throw failure('INVALID_INPUT');
    if (!path.isAbsolute(archiveDir)) throw failure('INVALID_INPUT');
    const archive = await openStorage({dir:archiveDir,readOnly:true});
    const {dir:privateRoot} = await openStorage({dir:path.join(archive.dir,'local-derive'),readOnly:true});
    temp=await fsp.mkdtemp(path.join(privateRoot,'.run-')); await fsp.chmod(temp,0o700);
    const p=path.join(temp,'prompt.txt'), s=path.join(temp,'schema.json');
    await fsp.writeFile(p,prompt,{mode:0o600,flag:'wx'}); await fsp.writeFile(s,schemaText,{mode:0o600,flag:'wx'});
    const env={PATH:'/opt/homebrew/bin:/usr/bin:/bin',TMPDIR:temp,LANG:'en_US.UTF-8',
      PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'};
    canaryDir = await fsp.mkdtemp(path.join(privateRoot,'.canary-'));
    const canary = path.join(canaryDir,'fixture.txt');
    await fsp.writeFile(canary,'synthetic isolation probe',{mode:0o600,flag:'wx'});
    // Keep system runtime reads available. Deny user data locations before
    // permitting this exact model and this invocation's scratch directory.
    const privateDirs = ['/Users',os.homedir(),archive.dir,await fsp.realpath(archive.dir),
      '/private/tmp','/tmp','/private/var/folders','/var/folders','/Volumes'];
    const denied = [...new Set(privateDirs)].map(dir => '(subpath ' + JSON.stringify(dir) + ')');
    const allowed = [...new Set([temp,await fsp.realpath(temp)])].map(dir => '(subpath ' + JSON.stringify(dir) + ')');
    allowed.push('(literal ' + JSON.stringify(MODEL) + ')');
    const profile = PROFILE + '(deny file-read* ' + denied.join('') + ')(allow file-read* ' + allowed.join('') + ')';
    await verifySandbox(env,profile,p,canary);
    if (await memoryFree() < 45) throw failure('MEMORY_ADMISSION');
    const args=['-p',profile,LLAMA,'--offline','--device','none','-ngl','0','--no-op-offload','--no-kv-offload','--load-mode','mmap','--no-repack','--no-warmup','--threads','2','--threads-batch','2','--ctx-size','768','--n-predict','384','--batch-size','64','--ubatch-size','32','--no-context-shift','--conversation','--single-turn','--jinja','--reasoning','off','--no-display-prompt','--simple-io','--color','off','--temp','0','--seed','42','--json-schema-file',s,'-f',p,'-m',MODEL];
    started=Date.now();
    const run=await new Promise(resolve=>{
      let out=Buffer.alloc(0), err=Buffer.alloc(0), done=false, sampling=false;
      const stop=code=>{if(!reason){reason=code; child?.kill('SIGKILL');}};
      try { child=spawn(SANDBOX,args,{env,cwd:temp,stdio:['ignore','pipe','pipe']}); }
      catch {return resolve({code:null,output:''});}
      child.stdout.on('data',b=>{if(out.length+b.length>64*1024)stop('OUTPUT_LIMIT');else out=Buffer.concat([out,b]);});
      child.stderr.on('data',b=>{if(err.length+b.length>256*1024)stop('DIAGNOSTIC_LIMIT');else err=Buffer.concat([err,b]);});
      const timer=setTimeout(()=>stop('TIME_LIMIT'),60000);
      const interval=setInterval(async()=>{
        if (sampling || done) return; sampling=true;
        try {
          const [pressure,proc]=await Promise.all([memoryFree(),command('/bin/ps',['-o','rss=','-p',String(child.pid)],{timeout:2500,env})]);
          if (done || child.exitCode !== null || child.signalCode !== null) return;
          if (pressure<25) return stop('MEMORY_PRESSURE');
          if (proc.code!==0 || !/^\s*\d+\s*$/.test(proc.out)) return stop('RSS_UNAVAILABLE');
          peak=Math.max(peak,Number(proc.out.trim())/1024);
          if (peak>6656) stop('RSS_LIMIT');
        } catch { if (!done) stop('MEMORY_UNAVAILABLE'); }
        finally { sampling=false; }
      },1000);
      child.on('error',()=>{reason ||= 'PROCESS_FAILED';});
      child.on('close',code=>{done=true;clearTimeout(timer);clearInterval(interval);resolve({code,output:out.toString('utf8'), diagnostic:err.toString('utf8')});});
    });
    const stats={wallSeconds:(Date.now()-started)/1000,peakObservedRssMiB:peak};
    const promptTokens = /prompt eval time\s*=\s*[0-9.]+ ms \/\s*(\d+) tokens/.exec(run.diagnostic || '');
    const generationRuns = /eval time\s*=\s*[0-9.]+ ms \/\s*(\d+) runs/.exec(run.diagnostic || '');
    if (promptTokens) stats.promptTokens = Number(promptTokens[1]);
    if (generationRuns) stats.generationRuns = Number(generationRuns[1]);
    if (reason || run.code!==0) throw failure(reason || 'PROCESS_FAILED',stats);
    return {output:run.output,stats};
  } catch(e) {
    if (e.safeLocal) throw e;
    throw failure('LOCAL_FAILED',child ? {wallSeconds:(Date.now()-started)/1000,peakObservedRssMiB:peak} : undefined);
  } finally {
    if (temp) await fsp.rm(temp,{recursive:true,force:true}).catch(()=>{});
    if (canaryDir) await fsp.rm(canaryDir,{recursive:true,force:true}).catch(()=>{});
  }
}
module.exports={prepareLocalModel,runLocalLlama};
