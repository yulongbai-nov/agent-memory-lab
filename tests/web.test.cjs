'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http'); const {createWebServer} = require('../lib/web/server.cjs');
test('local server rejects untrusted host, origin and write tokens', async t => {
 const row={scope:{owner:'a',project:'p'},source:{harness:'h',instance:'i',session:'s'},versionId:'v',item:{id:'x',kind:'message',text:'<script>alert(1)</script>'}}; let writes=0;
 const archive={listItems:async()=>[row],getItem:async ({owner,project})=>owner==='a' && project==='p' ? row : {scope:{owner,project},versionId:'secret-v',item:{id:'secret',text:'secret'}},listAnnotations:async()=>[],addAnnotation:async x=>{writes++; return x;}};
 const web=createWebServer({archive,owner:'a',project:'p'}); const {port}=await web.listen(); t.after(()=>web.close()); const base=`http://127.0.0.1:${port}`;
 const get=await fetch(base); const html=await get.text(); const token=html.match(/name="csrf" content="([^"]+)/)[1]; assert.equal(get.headers.get('cache-control'),'no-store'); new (require('node:vm').Script)(await (await fetch(base+'/app.js')).text());
 assert.equal((await fetch(base+'/api/find',{headers:{Origin:'https://evil.example'}})).status,403);
 const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(base,{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode)});req.on('error',reject)}); assert.equal(hostStatus,403);
 const attack = new URLSearchParams({citation:JSON.stringify({id:'secret',revision:'secret-v',owner:'other',project:'other'})}); assert.equal((await fetch(base+'/api/evidence?'+attack)).status,400);
 const citation={id:'x',revision:'v',source:row.source}; const body=JSON.stringify({kind:'annotation',text:'fix',target:citation,owner:'other',project:'other'});
 assert.equal((await fetch(base+'/api/annotations',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body})).status,403);
 assert.equal((await fetch(base+'/api/annotations',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-CSRF-Token':token},body})).status,201); assert.equal(writes,1);
 assert.throws(()=>createWebServer({archive,owner:'a',project:'p',host:'0.0.0.0'}));
});
test('real archive review POST is scoped and retries idempotently', async t => {
 const fs=require('node:fs/promises'), os=require('node:os'),path=require('node:path'), {openArchive}=require('../lib/archive.cjs'); const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-web-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const archive=await openArchive({dir}); const source={harness:'h',instance:'i',session:'s'};
 for (const project of ['p','secret']) await archive.importBatch({scope:{owner:'a',project},source,checkpoint:{position:1},items:[{id:project,kind:'message',text:project}]});
 const web=createWebServer({archive,owner:'a',project:'p'}), {port}=await web.listen(); t.after(()=>web.close()); const base=`http://127.0.0.1:${port}`, session=await (await fetch(base+'/api/session')).json(); const items=await archive.listItems({owner:'a',project:'p'}), other=await archive.listItems({owner:'a',project:'secret'}); const target={id:'p',revision:items[0].versionId,source};
 const headers={'Content-Type':'application/json',Origin:base,'X-CSRF-Token':session.csrf}, id='12345678-1234-1234-1234-123456789abc', body=JSON.stringify({id,kind:'decision',text:'Reviewed',target});
 assert.equal((await fetch(base+'/api/annotations',{method:'POST',headers,body})).status,201); assert.equal((await fetch(base+'/api/annotations',{method:'POST',headers,body})).status,201); assert.equal((await archive.listAnnotations({owner:'a',project:'p'})).length,1);
 const attack={id:'secret',revision:other[0].versionId,source,owner:'a',project:'secret'}; assert.equal((await fetch(base+'/api/evidence?'+new URLSearchParams({citation:JSON.stringify(attack)}))).status,400); assert.equal((await fetch(base+'/api/annotations',{method:'POST',headers,body:JSON.stringify({kind:'annotation',text:'x',target:attack})})).status,400);
 const post=async data => fetch(base+'/api/annotations',{method:'POST',headers,body:JSON.stringify(data)});
 const correction={id:'22345678-1234-1234-1234-123456789abc',kind:'correction',text:'Corrected',target,revises:id};
 assert.equal((await post({...correction,revises:undefined})).status,400);
 const futureCorrection = {...correction,valid_time:'2099-01-01T00:00:00Z'}; const rejected = await post(futureCorrection); assert.equal(rejected.status,400); assert.match(await rejected.text(),/immediately/); await assert.rejects(archive.addAnnotation({...futureCorrection,scope:{owner:'a',project:'p'}}),/immediately/); assert.equal((await archive.listAnnotations({owner:'a',project:'p'})).length,1);
 assert.equal((await post(correction)).status,201);
 let current=await (await fetch(base+'/api/current')).json(); assert.equal(current[0].text,'Corrected');
 const change={id:'32345678-1234-1234-1234-123456789abc',kind:'change',text:'Before',target,revises:id,valid_time:'2020-01-01T00:00:00Z'};
 // The original review has no effective time; a separate timed pair tests ordering.
 const timed={id:'42345678-1234-1234-1234-123456789abc',kind:'decision',text:'Timed',target,topic:'timed',valid_time:'2025-01-01T00:00:00Z'};
 assert.equal((await post(timed)).status,201); assert.equal((await post({...change,topic:'timed',revises:timed.id})).status,201);
 current=await (await fetch(base+'/api/current?topic=timed')).json(); assert.equal(current[0].label,'待核实');
 assert.equal((await post({...correction,id:'52345678-1234-1234-1234-123456789abc',topic:'other',revises:timed.id})).status,400);
 // Simulate a correction written by an older version, preserving its exact stored content.
 const file=path.join(dir,'archive.json'), state=JSON.parse(await fs.readFile(file,'utf8')); const legacy=Object.values(state.annotations).find(a=>a.id===correction.id); legacy.valid_time='2099-01-01T00:00:00Z'; await fs.writeFile(file,JSON.stringify(state));
 const docs=new Map(); const fetchImpl=async(url,opts={}) => {const u=new URL(url); if(u.pathname.endsWith('/_all_docs')) return {status:200,ok:true,json:async()=>({rows:[...docs.values()].sort((a,b)=>a._id.localeCompare(b._id)).map(doc=>({id:doc._id,doc}))})}; const key=decodeURIComponent(u.pathname.split('/').at(-1)); if(opts.method==='PUT'){if(docs.has(key)) return {status:409,ok:false}; docs.set(key,JSON.parse(opts.body)); return {status:201,ok:true};} return {status:200,ok:true,json:async()=>docs.get(key)};};
 const replica=await openArchive({dir:path.join(dir,'replica')}), config={owner:'a',project:'p',url:'http://localhost:5984/test',fetchImpl}; await archive.sync(config); await replica.sync(config); assert.deepEqual((await replica.listAnnotations({owner:'a',project:'p'})).find(a=>a.id===correction.id),legacy);
 const {createQuery}=require('../lib/query.cjs'); assert.equal((await createQuery(replica).current({owner:'a',project:'p'})).find(x=>x.topic==='h / i / s').text,'Corrected');
 const shell=await (await fetch(base+'/offline-shell')).text(); assert.doesNotMatch(shell,/name="csrf"/); const sw=await (await fetch(base+'/sw.js')).text(); new (require('node:vm').Script)(sw); assert.doesNotMatch(sw,/\/api\//);
});
test('local shell advertises install metadata without exposing new network routes', async t => {
 const archive={listItems:async()=>[],getItem:async()=>null,listAnnotations:async()=>[]}; const web=createWebServer({archive,owner:'synthetic',project:'demo'}); const {port}=await web.listen(); t.after(()=>web.close()); const base=`http://127.0.0.1:${port}`;
 const html=await (await fetch(base)).text(); assert.match(html,/rel="manifest"/); assert.match(html,/apple-touch-icon/);
 const response=await fetch(base+'/manifest.webmanifest'); assert.match(response.headers.get('content-type'),/application\/manifest\+json/); const manifest=await response.json(); assert.equal(manifest.start_url,'/'); assert.equal(manifest.display,'standalone');
 for (const size of [192,512]) {const r=await fetch(base+`/icons/app-${size}.png`); assert.equal(r.status,200); assert.equal(r.headers.get('content-type'),'image/png'); const bytes=Buffer.from(await r.arrayBuffer()); assert.equal(bytes.readUInt32BE(16),size); assert.equal(bytes.readUInt32BE(20),size);}
 assert.equal((await fetch(base+'/manifest.webmanifest',{headers:{Origin:'https://evil.example'}})).status,403);
 assert.throws(()=>createWebServer({archive,owner:'synthetic',project:'demo',host:'0.0.0.0'}));
});
test('opt-in tailnet origin fails closed and preserves exact CSRF origin', async t => {
 const archive={listItems:async()=>[],getItem:async()=>null,listAnnotations:async()=>[]};
 assert.throws(()=>createWebServer({archive,owner:'a',project:'p',externalOrigin:'http://example.test',allowedTailnetUser:'alice@example.test'}));
 assert.throws(()=>createWebServer({archive,owner:'a',project:'p',externalOrigin:'https://example.test'}));
 assert.throws(()=>createWebServer({archive,owner:'a',project:'p',externalOrigin:'https://example.test/path',allowedTailnetUser:'alice@example.test'}));
 const web=createWebServer({archive,owner:'a',project:'p',externalOrigin:'https://example.test',allowedTailnetUser:'alice@example.test'}); const {port}=await web.listen(); t.after(()=>web.close()); const base=`http://127.0.0.1:${port}`;
 const request=(pathname,options={})=>new Promise((resolve,reject)=>{const req=http.request(base+pathname,{method:options.method || 'GET',headers:options.headers || {}},r=>{let data='';r.on('data',x=>data+=x);r.on('end',()=>resolve({status:r.statusCode,json:async()=>JSON.parse(data)}));});req.on('error',reject);req.end(options.body);});
 const good={Host:'example.test','Tailscale-User-Login':'alice@example.test'};
 assert.equal((await request('/api/session',{headers:{Host:'example.test'}})).status,403);
 assert.equal((await request('/api/session',{headers:{...good,'Tailscale-User-Login':'other@example.test'}})).status,403);
 assert.equal((await request('/api/session',{headers:{...good,Host:'evil.test'}})).status,403);
 assert.equal((await request('/api/session',{headers:{...good,Origin:'https://evil.test'}})).status,403);
 const session=await request('/api/session',{headers:good}); assert.equal(session.status,200); const {csrf}=await session.json();
 assert.equal((await request('/api/annotations',{method:'POST',headers:{...good,Origin:'https://evil.test','X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await request('/api/annotations',{method:'POST',headers:{...good,Origin:'https://example.test','Content-Type':'application/json'},body:'{}'})).status,403);
 const ok=await request('/api/annotations',{method:'POST',headers:{...good,Origin:'https://example.test','X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}'}); assert.equal(ok.status,400);
 const duplicate=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/session',{headers:{Host:'example.test','Tailscale-User-Login':['alice@example.test','alice@example.test']}},r=>{r.resume();resolve(r.statusCode)}); req.on('error',reject); req.end();}); assert.equal(duplicate,403);
});
test('offline shell falls back on gateway failures but never masks access denial or caches API', async t => {
 const archive={listItems:async()=>[],getItem:async()=>null,listAnnotations:async()=>[]}, web=createWebServer({archive,owner:'a',project:'p'}); const {port}=await web.listen(); t.after(()=>web.close()); const script=await (await fetch(`http://127.0.0.1:${port}/sw.js`)).text(); const handlers={}; let networkStatus=503, cacheCalls=0;
 const self={location:{origin:'https://example.test'},addEventListener:(name,fn)=>{handlers[name]=fn;}}; const caches={match:async()=>{cacheCalls++;return {status:200,cached:true}}}; const context={self,caches,URL,fetch:async()=>({status:networkStatus})}; require('node:vm').runInNewContext(script,context);
 async function request(url,mode='navigate'){let response;handlers.fetch({request:{url,mode,method:'GET'},respondWith:p=>{response=p}});return response && await response;}
 assert.equal((await request('https://example.test/')).cached,true); networkStatus=502; assert.equal((await request('https://example.test/app.js','cors')).cached,true); networkStatus=403; assert.equal((await request('https://example.test/')).status,403); const count=cacheCalls; assert.equal(await request('https://example.test/api/evidence','cors'),undefined); assert.equal(cacheCalls,count);
});
