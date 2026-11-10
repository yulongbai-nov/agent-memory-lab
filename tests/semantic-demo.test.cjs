'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, rm, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { runSynthetic } = require('../lib/semantic-demo.cjs');
const { semanticQueue } = require('../lib/semantic-queue.cjs');

test('synthetic semantic run caches only validated output and can retry failure', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'memory-synthetic-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const usage = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 };
  let calls = 0;
  const invoke = async ({ prompt, schema }) => {
    calls++;
    const records = JSON.parse(prompt.split('\n').at(-1));
    assert.equal(records.length, 5);
    assert(records.every(record => record.source === 'synthetic-harness/session-demo'));
    assert(!prompt.includes('evt:decision-1'));
    assert.equal(schema.properties.candidates.maxItems, 4);
    const { source, item, version, text } = records[0];
    return {
      output: { candidates: [{ kind: 'decision', claim: 'Synthetic claim', evidence: [
        { source, item, version, quote: calls === 1 ? 'not in source' : text }
      ] }] },
      usage
    };
  };
  await assert.rejects(runSynthetic({ cacheDir, invoke }), error => {
    assert.match(error.message, /quote or source/);
    assert.deepEqual(error.usage, usage);
    return true;
  });
  assert.deepEqual(await readdir(cacheDir), []);
  const first = await runSynthetic({ cacheDir, invoke });
  assert.equal(first.modelCalls, 1);
  assert.equal(first.candidates[0].status, '待核实');
  const replay = await runSynthetic({ cacheDir, invoke });
  assert.equal(replay.modelCalls, 0);
  assert.equal(replay.cacheHit, true);
  assert.deepEqual(replay.candidates, first.candidates);
  assert.equal(calls, 2);
});

test('private semantic queue exposes counts without including previews', () => {
  const result = semanticQueue([
    { versionId: 'one', item: { role: 'user', text: 'private sample' } },
    { versionId: 'two', item: { role: 'assistant', text: 'ignored' } }
  ]);
  assert.deepEqual(result.pending, ['one']);
  assert.deepEqual(result.stats, {
    semanticStatus: 'requires-user-consent', semanticItemsPending: 1, previewBytes: 14, modelCalls: 0
  });
  assert(!JSON.stringify(result).includes('private sample'));
});

test('injected runtime cannot poison the production namespace and provenance is checked', async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'memory-provenance-')); t.after(() => rm(cacheDir,{recursive:true,force:true}));
  const usage = {input_tokens:1,cached_input_tokens:0,output_tokens:1};
  await assert.rejects(runSynthetic({invoke:async()=>{throw new Error('must not run')}}),/explicit private cache/);
  const invoke=async()=>({output:{candidates:[]},usage});
  const mock=await runSynthetic({cacheDir,invoke}); assert.equal(mock.runtime,'injected-test');
  const mockFile=(await readdir(cacheDir)).find(name=>name.endsWith('.json'));
  const entry=JSON.parse(await readFile(join(cacheDir,mockFile),'utf8'));
  assert.equal(entry.metadata.runtime,'injected-test');
  const productionMetadata={...entry.metadata,runtime:'codex-cli'};
  const {createHash}=require('node:crypto');
  const productionKey=createHash('sha256').update(JSON.stringify(productionMetadata)).digest('hex');
  assert.notEqual(mockFile,productionKey+'.json');
  // Fabricate a separately stamped production cache fixture; this test never launches a model.
  const productionPath=join(cacheDir,productionKey+'.json');
  await writeFile(productionPath,JSON.stringify({metadata:productionMetadata,output:{candidates:[]},usage}),{mode:0o600});
  const hit=await runSynthetic({cacheDir}); assert.equal(hit.runtime,'codex-cli'); assert.equal(hit.cacheHit,true); assert.equal(hit.requestedModel,'gpt-6-luna'); assert.equal(hit.requestedEffort,'low');
  await writeFile(productionPath,JSON.stringify({metadata:entry.metadata,output:entry.output,usage}),{mode:0o600});
  await assert.rejects(runSynthetic({cacheDir}),/provenance mismatch/);
  await writeFile(productionPath,JSON.stringify({output:entry.output,usage}),{mode:0o600});
  await assert.rejects(runSynthetic({cacheDir}),/provenance mismatch/);
});
