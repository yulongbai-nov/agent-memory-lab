'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {withWriterLock} = require('../lib/lock.cjs');
const lockModule = require.resolve('../lib/lock.cjs');
function child(dir, name, hold, legacy = "") {
 const script = `const {withWriterLock}=require(${JSON.stringify(lockModule)}); withWriterLock(process.argv[1],process.argv[2],async()=>{ process.send('locked'); await new Promise(r=>setTimeout(r,Number(process.argv[3]))); },{timeoutMs:5000,legacyLock:process.argv[4] || undefined}).then(()=>process.exit(0),()=>process.exit(1));`;
 return spawn(process.execPath,['-e',script,dir,name,String(hold),legacy],{stdio:['ignore','ignore','ignore','ipc']});
}
test('cross-process locks wait and recover when a holder is killed', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'writer-lock-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const holder=child(dir,'archive',30000); t.after(()=>holder.kill('SIGKILL'));
 assert.equal((await once(holder,'message'))[0],'locked');
 const contender=child(dir,'archive',1); t.after(()=>contender.kill('SIGKILL'));
 let acquired=false; contender.on('message',()=>{acquired=true;});
 await new Promise(r=>setTimeout(r,150)); assert.equal(acquired,false);
 await assert.rejects(withWriterLock(dir,'archive',async()=>{}, {timeoutMs:100,retryMs:10}),/timed out/);
 let independent=false; await withWriterLock(dir,'derived',async()=>{independent=true;},{timeoutMs:200}); assert.ok(independent);
 holder.kill('SIGKILL'); await once(holder,'exit');
 await once(contender,'exit'); assert.equal(acquired,true); assert.equal(contender.exitCode,0);
});
test('legacy locks are respected without removing them', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-lock-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const old=path.join(dir,'.archive.lock'); await fs.writeFile(old,'',{mode:0o600});
 await assert.rejects(withWriterLock(dir,'archive',async()=>{}, {legacyLock:'.archive.lock',timeoutMs:60,retryMs:10}),/timed out/);
 assert.ok(await fs.stat(old)); await fs.rm(old);
 await withWriterLock(dir,'archive',async()=>{}, {legacyLock:'.archive.lock',timeoutMs:100});
});

test('new marker excludes legacy writers and is recovered after SIGKILL', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'interop-lock-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const holder=child(dir,'archive',30000,'.archive.lock'); t.after(()=>holder.kill('SIGKILL'));
 await once(holder,'message'); const marker=path.join(dir,'.archive.lock');
 await assert.rejects(fs.open(marker,'wx',0o600),{code:'EEXIST'});
 holder.kill('SIGKILL'); await once(holder,'exit'); assert.ok(await fs.stat(marker));
 await withWriterLock(dir,'archive',async()=>{ await assert.rejects(fs.open(marker,'wx',0o600),{code:'EEXIST'}); },{legacyLock:'.archive.lock',timeoutMs:1000});
 await assert.rejects(fs.stat(marker),{code:'ENOENT'});
});
