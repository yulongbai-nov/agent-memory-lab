'use strict';
// Opt-in only: an isolated disposable CouchDB container, synthetic records.
const {execFileSync} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {openArchive} = require('../lib/archive.cjs');
const {provision} = require('../lib/storage-couch.cjs');
const token = () => crypto.randomBytes(18).toString('hex');
const auth = (name,secret) => 'Basic '+Buffer.from(`${name}:${secret}`).toString('base64');
const docker = (...args) => execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
(async () => {
 const name = `memory-hub-${token().slice(0,12)}`, admin = token(), writer = token(), reader = token(), annotator = token();
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'memory-hub-'));
 let started = false;
 try {
  docker('run','-d','--rm','--name',name,'-p','127.0.0.1::5984','-e',`COUCHDB_USER=admin`,'-e',`COUCHDB_PASSWORD=${admin}`,'couchdb:3.5.3@sha256:907eab5b7e55ab7cfd241d39b90b2a335ea40bef82acee5a37388c08bf201dda'); started = true;
  const port = docker('port',name,'5984/tcp').split(':').at(-1), base = `http://127.0.0.1:${port}`;
  const request = async (url,authorization,method='GET',body) => fetch(base+url,{method,headers:{authorization,'content-type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)}),redirect:'manual'});
  const adminAuth = auth('admin',admin), writerAuth = auth('writer',writer), readerAuth = auth('reader',reader), annotatorAuth = auth('annotator',annotator);
  let ready = false;
  for (let i=0;i<60;i++) { try { if ((await fetch(base)).ok) {ready=true; break;} } catch {} await new Promise(r=>setTimeout(r,500)); }
  assert.ok(ready,'CouchDB failed to start');
  for (const db of ['_users','_replicator','archive']) assert.ok((await request('/'+db,adminAuth,'PUT')).ok);
  for (const [user,password,role] of [['writer',writer,'archive_writer'],['reader',reader,'archive_reader'],['annotator',annotator,'archive_annotator']]) assert.ok((await request('/_users/org.couchdb.user:'+user,adminAuth,'PUT',{_id:'org.couchdb.user:'+user,name:user,password,roles:[role],type:'user'})).ok);
  await provision({url:base+'/archive',authorization:adminAuth});
  const scope = {owner:'synthetic',project:'project'}, source={harness:'test',instance:'one',session:'s'};
  const a=await openArchive({dir:path.join(root,'a')}), b=await openArchive({dir:path.join(root,'b')});
  await a.importBatch({scope,source,checkpoint:{position:1},items:[{id:'m',kind:'message',text:'synthetic'}]});
  const options = {...scope,url:base+'/archive',authorization:writerAuth};
  await a.sync(options); assert.equal((await b.sync(options)).pulled,1);
  assert.equal((await b.getItem({...scope,id:'m'})).item.text,'synthetic');
  const item = await a.getItem({...scope,id:'m'});
  await b.addAnnotation({scope,id:'review',kind:'note',text:'synthetic note',target:{id:'m',revision:item.versionId}});
  await b.sync({...options,authorization:annotatorAuth,mode:'annotations'}); await a.sync(options); assert.equal((await a.listAnnotations(scope)).length,1);
  const rows=await (await request('/archive/_all_docs?include_docs=true',readerAuth)).json();
  const doc=rows.rows.find(r=>r.id.startsWith('immutable:')).doc;
  assert.ok((await request('/archive/_all_docs',readerAuth)).ok);
  assert.equal((await b.sync({...options,authorization:readerAuth,mode:'pull'})).pushed,0);
  assert.equal((await request('/archive/immutable:annotator-raw',annotatorAuth,'PUT',{type:'immutable',payload:{kind:'version',record:{}}})).status,403);
  assert.equal((await request('/archive/'+encodeURIComponent(doc._id),annotatorAuth,'PUT',{...doc,payload:{x:2}})).status,403);
  assert.equal((await request('/archive/'+encodeURIComponent(doc._id)+'?rev='+encodeURIComponent(doc._rev),annotatorAuth,'DELETE')).status,403);
  assert.equal((await request('/archive/immutable:forbidden',readerAuth,'PUT',{type:'immutable',payload:{x:1}})).status,403);
  assert.equal((await request('/archive/'+encodeURIComponent(doc._id),readerAuth,'PUT',{...doc,payload:{x:2}})).status,403);
  assert.equal((await request('/archive/'+encodeURIComponent(doc._id)+'?rev='+encodeURIComponent(doc._rev),readerAuth,'DELETE')).status,403);
  assert.equal((await request('/archive/'+encodeURIComponent(doc._id),writerAuth,'PUT',{...doc,payload:{x:2}})).status,403);
  assert.equal((await request('/archive/'+encodeURIComponent(doc._id)+'?rev='+encodeURIComponent(doc._rev),writerAuth,'DELETE')).status,403);
  assert.equal((await request('/archive/immutable:forbidden',readerAuth,'PUT',{type:'immutable',payload:{x:1}})).status,403);
  console.log('PASS: protected two-profile sync, reader access and append-only role checks');
 } finally { if (started) { try { docker('rm','-f',name); } catch {} } await fs.rm(root,{recursive:true,force:true}); }
})().catch(err=>{console.error('Protected CouchDB scenario failed:', err.code || err.name);process.exitCode=1;});
