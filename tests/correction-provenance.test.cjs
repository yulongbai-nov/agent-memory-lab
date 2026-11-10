'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const {promisify}=require('node:util'); const execFile=promisify(require('node:child_process').execFile);
const {openArchive}=require('../lib/archive.cjs'); const {createQuery}=require('../lib/query.cjs');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js'); const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
test('cross-source corrections preserve original citation and exact separate evidence',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'correction-provenance-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const archive=await openArchive({dir});
 const scope={owner:'synthetic',project:'demo'}, dsh={harness:'dsh',instance:'i',session:'one'}, codex={harness:'codex',instance:'i',session:'two'};
 for(const [source,id,text] of [[dsh,'old','original decision'],[codex,'new','later correction']]) await archive.importBatch({scope,source,checkpoint:{position:1},items:[{id,kind:'message',text}]});
 const old=await archive.getItem({...scope,id:'old'}), newer=await archive.getItem({...scope,id:'new'}), target={id:'old',revision:old.versionId,source:dsh}, evidence={id:'new',revision:newer.versionId,source:codex};
 await archive.addAnnotation({scope,id:'decision',kind:'decision',topic:'Topic',text:'first understanding',target});
 const args=['bin/memory.cjs','annotate','--dir',dir,'--owner',scope.owner,'--project',scope.project,'--id','correction','--kind','correction','--text','corrected meaning','--revises','decision','--target',JSON.stringify(target),'--evidence',JSON.stringify(evidence)];
 await execFile(process.execPath,args,{cwd:path.join(__dirname,'..')});
 const q=createQuery(archive), current=(await q.current({...scope,topic:'Topic'}))[0]; assert.equal(current.text,'corrected meaning'); assert.deepEqual(current.citation,target); assert.deepEqual(current.effectiveCitation,evidence); assert.deepEqual(current.correction.evidence,evidence);
 const row=(await q.timeline({...scope,topic:'Topic'})).find(x=>x.review_id==='decision'); assert.deepEqual(row.annotations[0].evidence,evidence);
 for (const bad of [{...evidence,revision:'bad'},{...evidence,source:dsh},{id:'missing',revision:newer.versionId}]) await assert.rejects(archive.addAnnotation({scope,id:'bad',kind:'correction',text:'bad',revises:'decision',target,evidence:bad}));
 await archive.importBatch({scope:{owner:'synthetic',project:'other'},source:codex,checkpoint:{position:1},items:[{id:'private',kind:'message',text:'other scope'}]}); const other=await archive.getItem({owner:'synthetic',project:'other',id:'private'});
 await assert.rejects(archive.addAnnotation({scope,id:'bad',kind:'correction',text:'bad',revises:'decision',target,evidence:{id:'private',revision:other.versionId}}));
 await assert.rejects(archive.addAnnotation({scope,id:'bad',kind:'note',text:'bad',target,evidence}));
 await archive.addAnnotation({scope,id:'manual-decision',kind:'decision',text:'original',topic:'Manual',target}); await archive.addAnnotation({scope,id:'manual-fix',kind:'correction',text:'manual correction',target,revises:'manual-decision'});
 const manual=(await q.current({...scope,topic:'Manual'}))[0]; assert.equal(manual.text,'manual correction'); assert.deepEqual(manual.citation,target); assert.equal(Object.hasOwn(manual,'effectiveCitation'),false); assert.equal(Object.hasOwn(manual.correction,'evidence'),false);
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(__dirname,'../bin/memory.cjs'),'mcp','--allow-annotations','--dir',dir,'--owner',scope.owner,'--project',scope.project],stderr:'pipe'}); const client=new Client({name:'synthetic-provenance',version:'1'}); t.after(()=>client.close()); await client.connect(transport);
 await archive.addAnnotation({scope,id:'mcp-decision',kind:'decision',text:'MCP original',topic:'MCP',target});
 const result=await client.callTool({name:'memory_annotate',arguments:{id:'mcp-fix',kind:'correction',text:'MCP corrected',revises:'mcp-decision',target,evidence}}); assert.equal(result.isError,undefined);
 const correct=await client.callTool({name:'memory_evidence',arguments:evidence}); assert.equal(correct.isError,undefined);
 assert.equal(await archive.getItem({...scope,id:evidence.id,revision:evidence.revision,source:dsh}),null); await assert.rejects(q.evidence({...scope,...evidence,source:dsh}));
 const wrong=await client.callTool({name:'memory_evidence',arguments:{...evidence,source:dsh}}); assert.equal(wrong.isError,true);
 const legacy=await client.callTool({name:'memory_evidence',arguments:{id:evidence.id,revision:evidence.revision}}); assert.equal(legacy.isError,undefined);
 for (const source of [null,{},'',{harness:'codex',instance:'',session:'two'}]) { await assert.rejects(q.evidence({...scope,id:evidence.id,revision:evidence.revision,source})); await assert.rejects(archive.getItem({...scope,id:evidence.id,revision:evidence.revision,source})); await assert.rejects(archive.addAnnotation({scope,id:'bad-source',kind:'correction',text:'bad',target,revises:'decision',evidence:{...evidence,source}})); }
 const mcpCurrent=await client.callTool({name:'memory_current',arguments:{topic:'MCP'}}); assert.deepEqual(JSON.parse(mcpCurrent.content[0].text)[0].effectiveCitation,evidence);
});
test('SQLite validates and preserves correction evidence across sources',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'correction-sqlite-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); let a=await openArchive({dir}); const scope={owner:'s',project:'p'}, dsh={harness:'dsh',instance:'i',session:'s'}, codex={harness:'codex',instance:'i',session:'s'};
 for(const [source,id] of [[dsh,'one'],[codex,'two']]) await a.importBatch({scope,source,checkpoint:{position:1},items:[{id,kind:'message',text:id}]}); const old=await a.getItem({...scope,id:'one'}), revised=await a.getItem({...scope,id:'two'}); const target={id:'one',revision:old.versionId,source:dsh}, evidence={id:'two',revision:revised.versionId,source:codex}; await a.addAnnotation({scope,id:'decision',kind:'decision',topic:'T',text:'old',target}); await require('../lib/storage-sqlite.cjs').migrateJsonToSqlite({dir}); a=await openArchive({dir}); await a.addAnnotation({scope,id:'correction',kind:'correction',text:'new',target,revises:'decision',evidence}); assert.deepEqual((await createQuery(a).current({...scope,topic:'T'}))[0].effectiveCitation,evidence); await assert.rejects(a.addAnnotation({scope,id:'bad',kind:'correction',text:'bad',target,revises:'decision',evidence:{id:'two',revision:'wrong'}}));
});
