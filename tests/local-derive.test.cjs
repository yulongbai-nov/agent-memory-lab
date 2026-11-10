'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readdir, readFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runLocalDerive, selectLocalBatch } = require('../lib/local-derive.cjs');
const { openArchive } = require('../lib/archive.cjs');
const { migrateJsonToSqlite } = require('../lib/storage-sqlite.cjs');
const { originalCapture } = require('../lib/originals.cjs');

test('synthetic local cache validates output, retries failure and isolates injected results', async t => {
  const dir = await mkdtemp(join(tmpdir(),'memory-local-test-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const scope = {owner:'local',project:'synthetic'};
  let calls = 0;
  const runner = {
    async prepareLocalModel() { return {fingerprint:'test-model'}; },
    async runLocalLlama({prompt}) {
      calls++;
      const [{source,item,version,text}] = JSON.parse(prompt.split('\n').at(-1));
      return {output: JSON.stringify({candidates:[{kind:'decision',claim:'Example ![image](https://example.invalid/a) <img src=x> www.example.invalid',evidence:[
        {source,item,version,quote:calls === 1 ? 'not present' : text}
      ]}]}),stats:{wallSeconds:1,peakObservedRssMiB:2}};
    }
  };
  const input = {...scope,dir,synthetic:true};
  const failed = await runLocalDerive(input,runner);
  assert.equal(failed.status,'retryable');
  assert.equal(failed.modelCalls,1);
  assert.deepEqual(await readdir(join(dir,'local-derive')),[]);
  const success = await runLocalDerive(input,runner);
  assert.equal(success.status,'validated');
  assert.equal(success.exactReferences,1);
  assert.equal((await runLocalDerive(input,runner)).modelCalls,0);
  assert.equal(calls,2);
  assert(!(await readdir(join(dir,'local-derive'))).some(file => file.startsWith('latest-')));
  assert(!JSON.stringify(success).includes('Example'));
  const drafts = (await readdir(join(dir,'local-derive'))).filter(file => file.endsWith('.txt'));
  assert.equal(drafts.length,1);
  const draftPath = join(dir,'local-derive',drafts[0]);
  const draft = await readFile(draftPath,'utf8');
  assert.equal((await stat(draftPath)).mode & 0o777,0o600);
  assert.match(draft,/待核实/);
  assert.match(draft,/msg-001/);
  assert.match(draft,/作为起点/);
  assert.doesNotMatch(draft,/<img|https:\/\/|!\[|www\.example/);

});

test('private selector uses only complete scoped messages with local original references', async t => {
  const dir = await mkdtemp(join(tmpdir(),'memory-local-select-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const archive = await openArchive({dir});
  const scope = {owner:'local',project:'one'};
  const source = {harness:'dsh',instance:'instance',session:'session'};
  const original = await originalCapture(dir)({bytes:Buffer.from('{"synthetic":true}\n'),coordinate:1});
  const meta = (recordType,coordinate) => ({recordType,coordinate,original});
  await archive.importBatch({scope,source,checkpoint:{position:1},items:[
    {id:'u',kind:'message',role:'user',turnId:'closed',text:'Please prepare the release notes.',metadata:meta('user/message',1)},
    {id:'a',kind:'message',role:'assistant',turnId:'closed',text:'The release notes are next.',metadata:meta('assistant/message',2)},
    {id:'s',kind:'message',role:'user',turnId:'closed',text:'Contact synthetic@example.net for details.',metadata:meta('user/message',3)},
    {id:'tool',kind:'message',role:'assistant',turnId:'closed',text:'Synthetic tool content',metadata:meta('tool/call',4)},
    {id:'end',kind:'event',status:'completed',turnId:'closed',metadata:meta('turn/end',5)},
    {id:'live',kind:'message',role:'user',turnId:'open',text:'Unfinished content',metadata:meta('user/message',6)},
    {id:'unrelated-end',kind:'event',status:'completed',turnId:'unrelated',metadata:meta('turn/end',7)},
    ...Array.from({length:101}, (_,index) => ({
      id:'assistant-'+index,kind:'message',role:'assistant',turnId:'unrelated',
      time:'2026-01-01T00:00:00Z',text:'Synthetic unrelated assistant content.',
      metadata:meta('assistant/message',index+8)
    })),
    ...Array.from({length:1500}, (_,index) => ({
      id:'noise-'+index,kind:'tool_result',status:'completed',turnId:'noise',
      time:'2026-01-01T00:00:00Z',metadata:meta('tool/result',index+7)
    }))
  ]});
  await migrateJsonToSqlite({dir});
  const readOnly = await openArchive({dir,readOnly:true});
  const batch = await selectLocalBatch(readOnly,scope);
  assert.deepEqual(batch.records.map(row=>row.item),['u','a']);
  assert.equal(batch.availability.archived,2);
  assert.equal((await selectLocalBatch(readOnly,{...scope,project:'other'})).records.length,0);
  const input = {dir,...scope};
  let calls = 0;
  const runner = {
    async prepareLocalModel() { return {fingerprint:'test-model'}; },
    async runLocalLlama({prompt}) {
      calls++;
      const [first] = JSON.parse(prompt.split('\n').at(-1));
      const {source,item,version,text} = first;
      return {output:JSON.stringify({candidates:[{kind:'todo',claim:'Draft next step',evidence:[
        {source,item,version,quote:text}
      ]}]}),stats:{}};
    }
  };
  const first = await runLocalDerive(input,runner);
  assert.equal(first.exactReferences,1);
  assert.equal((await runLocalDerive(input,runner)).modelCalls,0);
  const writable = await openArchive({dir});
  await writable.importBatch({scope,source,checkpoint:{previous:1,position:2},items:[
    {id:'u',kind:'message',role:'user',turnId:'closed',time:'2026-01-02T00:00:00Z',
      text:'Next step: prepare the updated release notes.',metadata:meta('user/message',1)}
  ]});
  const updated = await runLocalDerive(input,runner);
  assert.equal(updated.exactReferences,1);
  assert.equal(updated.cacheHit,false);
  assert.equal(calls,2);
  const folder = join(dir,'local-derive');
  const drafts = (await readdir(folder)).filter(file => file.endsWith('.txt'));
  assert.equal(drafts.length,2);
  const draftsText = await Promise.all(drafts.map(file => readFile(join(folder,file),'utf8')));
  assert(draftsText.some(text => text.includes('updated release notes')));
  assert.equal((await writable.listAnnotations(scope)).length,0);

});

test('local derivation refuses a Git repository nested at its private output path', async t => {
  const dir = await mkdtemp(join(tmpdir(),'memory-local-nested-git-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const folder = join(dir,'local-derive');
  await mkdir(folder,{mode:0o700});
  require('node:child_process').execFileSync('git',['init','-q',folder]);
  let prepared = false;
  const runner = {
    async prepareLocalModel() { prepared = true; return {fingerprint:'test-model'}; },
    async runLocalLlama() { assert.fail('Nested worktree must not launch a model'); }
  };
  await assert.rejects(runLocalDerive({dir,owner:'local',project:'demo',synthetic:true},runner),
    /Private archive must be outside Git worktrees/);
  assert.equal(prepared,false);
  assert.deepEqual(await readdir(folder),['.git']);
  assert.deepEqual(await readdir(dir),['local-derive']);
});
