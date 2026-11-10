'use strict';
// Synthetic-only: disposable loopback CouchDB and two independent private archives.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const {openArchive}=require('../../lib/archive.cjs');
const {provision}=require('../../lib/storage-couch.cjs');
const {createQuery}=require('../../lib/query.cjs');
const {verifyOriginal}=require('../../lib/originals.cjs');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const token=()=>crypto.randomBytes(24).toString('hex');
(async()=>{
 const [sourceDir,destDir]=process.argv.slice(2); if(!sourceDir||!destDir)throw Error('fixture directories required');
 if ((await fs.readFile(path.join(sourceDir,'.synthetic-harness-fixture'),'utf8')) !== 'synthetic-only\n') throw Error('synthetic marker required');
 const secret=token(),writerSecret=token(),name='memlab-handoff-'+token().slice(0,12), temp=await fs.mkdtemp(path.join(os.tmpdir(),'memlab-handoff-'));
 let started=false, source,dest;
 try {
  const envfile=path.join(temp,'env'); await fs.writeFile(envfile,`COUCHDB_USER=admin\nCOUCHDB_PASSWORD=${secret}\n`,{mode:0o600});
  docker('run','-d','--rm','--name',name,'--env-file',envfile,'--network','bridge','-p','127.0.0.1::5984','--memory','1g','--cpus','1','couchdb:3.5.3@sha256:907eab5b7e55ab7cfd241d39b90b2a335ea40bef82acee5a37388c08bf201dda'); started=true;
  const port=docker('port',name,'5984/tcp').split(':').at(-1), base='http://127.0.0.1:'+port;
  const auth=(u,p)=>'Basic '+Buffer.from(u+':'+p).toString('base64'); const admin=auth('admin',secret),writer=auth('writer',writerSecret);
  const request=async (route,method='GET',body)=>fetch(base+route,{method,headers:{authorization:admin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});
  let ready=false; for(let i=0;i<90;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,500));} assert.ok(ready,'hub unavailable');
  for(const db of ['_users','_replicator','fixture']) assert.ok((await request('/'+db,'PUT')).ok);
  assert.ok((await request('/_users/org.couchdb.user:writer','PUT',{_id:'org.couchdb.user:writer',type:'user',name:'writer',password:writerSecret,roles:['archive_writer']})).ok);
  await provision({url:base+'/fixture',authorization:admin});
  source=await openArchive({dir:sourceDir}); dest=await openArchive({dir:destDir});
  const scope={owner:'synthetic',project:'release'}, sync={...scope,url:base+'/fixture',authorization:writer};
  await source.sync(sync); const received=await dest.sync(sync); assert.ok(received.pulled>0);
  const reviewed=await createQuery(source).current({...scope,topic:'Release rehearsal'});
  const target=reviewed[0].citation;
  // Independent edits while disconnected, followed by two-way convergence.
  await source.addAnnotation({scope,id:'offline-source-note',kind:'note',text:'Synthetic source-side review',target});
  await dest.addAnnotation({scope,id:'offline-replica-note',kind:'note',text:'Synthetic replica-side review',target});
  await source.sync(sync); await dest.sync(sync); await source.sync(sync);
  const before=await source.listItems(scope),after=await dest.listItems(scope);
  assert.deepEqual(new Set(before.map(v=>v.versionId)),new Set(after.map(v=>v.versionId)));
  assert.deepEqual(new Set((await source.listAnnotations(scope)).map(a=>a.id)),new Set((await dest.listAnnotations(scope)).map(a=>a.id)));
  assert.equal((await dest.listItems({owner:'synthetic',project:'other'})).length,0);
  // Originals are currently a separate file asset; Couch sync replicates references only.
  await fs.cp(path.join(sourceDir,'originals'),path.join(destDir,'originals'),{recursive:true,errorOnExist:true});
  const q=createQuery(dest), current=await q.current({...scope,topic:'Release rehearsal'});
  assert.equal(current.length,1); assert.notEqual(current[0].citation.revision,current[0].effectiveCitation.revision);
  for(const citation of [current[0].citation,current[0].effectiveCitation]) {
    const item=await dest.getItem({...scope,id:citation.id,revision:citation.revision}); assert.equal((await verifyOriginal(dest.dir,item.item.metadata.original)).verified,true);
  }
  await fs.writeFile(path.join(destDir,'.synthetic-harness-fixture'),'synthetic-only\n',{mode:0o600,flag:'wx'});
  console.log('PASS: independent offline edits converged through temporary CouchDB; originals copied separately and verified');
 } finally {
  source?.close?.();dest?.close?.(); if(started){try{docker('rm','-f',name);}catch{}}
  await fs.rm(temp,{recursive:true,force:true});
 }
})().catch(()=>{console.error('BLOCKED: synthetic archive handoff failed');process.exitCode=1;});
