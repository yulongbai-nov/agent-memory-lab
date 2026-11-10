'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readCodex, readDsh, sourceIdentity } = require('../lib/adapters');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-'));
const base = { owner: 'owner', project: 'project', instance: 'instance', session: 'session' };
const collect = async iterable => { const batches = []; for await (const b of iterable) batches.push(b); return batches; };
(async () => {
  try {
    const file = path.join(dir, 'session.jsonl');
    const records = [
      { timestamp: '2026-01-01T00:00:00Z', type: 'response_item', payload: { type: 'message', id: 'message-1', role: 'user', content: [{ text: 'hello token=supersecret /Users/alice/private.txt' }] } },
      { type: 'turn/end', turnId: 'turn-1' },
      { type: 'contextCompaction', text: 'summary' }
    ];
    fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
    const opts = { ...base, file, batchSize: 1, parent: 'parent', forkBoundary: 'boundary' };
    const batches = await collect(readCodex(opts));
    const items = batches.flatMap(b => b.items);
    assert.equal(items.length, 3);
    assert.equal(items[1].status, 'completed');
    assert.equal(items[2].kind, 'compression');
    assert.equal(batches.at(-1).checkpoint.position, 3);
    assert.equal(batches.at(-1).source.coverage.complete, true);
    assert(!JSON.stringify(batches).includes('supersecret'));
    assert(!JSON.stringify(batches).includes('/Users/alice'));
    const replay = (await collect(readCodex(opts))).flatMap(b => b.items);
    assert.equal(replay[0].id, items[0].id);
    assert.equal(replay[0].revision, items[0].revision);
    const incremental = await collect(readCodex({ ...opts, checkpoint: { position: 3 }, lookback: 1 }));
    assert.equal(incremental.flatMap(b => b.items).length, 1);
    const limited = await collect(readCodex({ ...opts, maxRecords: 1 }));
    assert.equal(limited.at(-1).checkpoint.position, 1);
    assert.equal(limited.at(-1).source.coverage.complete, false);
    fs.appendFileSync(file, '{"type":"message"');
    const partial = await collect(readCodex({ ...opts, checkpoint: { position: 3 }, lookback: 0 }));
    assert.equal(partial.at(-1).checkpoint.position, 3);
    assert.equal(partial.at(-1).source.coverage.gaps.at(-1).reason, 'partial-tail');
    const compressed = path.join(dir, 'session.zstd');
    fs.writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from(records.map(JSON.stringify).join('\n') + '\n')));
    const dsh = await collect(readDsh({ ...base, file: compressed }));
    assert.equal(dsh.flatMap(b => b.items).length, 3);
    assert.equal(dsh[0].source.harness, 'dsh');
    const realShape = path.join(dir, 'dsh.jsonl');
    fs.writeFileSync(realShape, [
      {type:'turn/start',seq:1,time:'2026-01-01T00:00:00Z',data:{turn:'t'}},
      {type:'message',seq:2,data:{role:'assistant',message:{id:'m',content:[{text:'answer'}]}}},
      {type:'tool/call',seq:3,data:{callId:'c',text:'call'}},
      {type:'tool/result',seq:5,data:{callId:'c',text:'result'}},
      {type:'turn/end',seq:6,data:{turn:'t',reason:'interrupted'}}
    ].map(JSON.stringify).join('\n') + '\n');
    const real = await collect(readDsh({...base, file:realShape}));
    const ri = real.flatMap(b => b.items);
    assert.equal(ri[1].text, 'answer');
    assert.equal(ri[1].role, 'assistant');
    assert.equal(ri[1].turnId, ri[0].turnId);
    assert.notEqual(ri[2].id, ri[3].id);
    assert.equal(ri[4].status, 'interrupted');
    assert(real.at(-1).source.coverage.gaps.some(g => g.reason === 'source-sequence-gap'));
    assert.deepEqual(sourceIdentity({harness:'dsh',instance:base.instance,session:base.session}), (({harness,instance,session}) => ({harness,instance,session}))(real[0].source));
    assert.equal(real[0].checkpoint.previous, null);
    const progress = await collect(readDsh({...base,file:realShape,checkpoint:{position:3},lookback:50,maxRecords:1}));
    assert.equal(progress.at(-1).checkpoint.position, 4);
    const gapFile = path.join(dir, 'gap.jsonl');
    await fs.promises.writeFile(gapFile, '{bad}\n' + [2,3,4,5].map(n => JSON.stringify({type:'message',text:String(n)})).join('\n') + '\n');
    const initial = await collect(readCodex({...base,file:gapFile,lookback:0}));
    let checkpoint = {position:initial.at(-1).checkpoint.position,source:initial.at(-1).source};
    assert(checkpoint.source.coverage.gaps.some(g => g.reason === 'invalid-json' && g.coordinate === 1));
    const again = await collect(readCodex({...base,file:gapFile,checkpoint,lookback:0,maxRecords:2}));
    checkpoint = {position:again.at(-1).checkpoint.position,source:again.at(-1).source};
    assert(checkpoint.source.coverage.gaps.some(g => g.reason === 'invalid-json' && g.coordinate === 1));
    await fs.promises.writeFile(gapFile, JSON.stringify({type:'message',text:'repaired'}) + '\n' + [2,3,4,5].map(n => JSON.stringify({type:'message',text:String(n)})).join('\n') + '\n');
    const repaired = await collect(readCodex({...base,file:gapFile,checkpoint,lookback:0,maxRecords:2}));
    assert(repaired.flatMap(b => b.items).some(item => item.text === 'repaired'));
    assert(!repaired.at(-1).source.coverage.gaps.some(g => g.reason === 'invalid-json' && g.coordinate === 1));
    assert.equal(repaired.at(-1).source.coverage.priorRangeUnverified, true);
    const fairFile = path.join(dir, 'fair.jsonl');
    const fairBody = ['{bad}', '{bad}', ...[3,4,5].map(n => JSON.stringify({type:'message',text:String(n)}))];
    await fs.promises.writeFile(fairFile, fairBody.join('\n') + '\n');
    const fairFirst = await collect(readCodex({...base,file:fairFile,lookback:0}));
    let fairCheckpoint = {position:fairFirst.at(-1).checkpoint.position,source:fairFirst.at(-1).source};
    fairBody[1] = JSON.stringify({type:'message',text:'fixed second'});
    await fs.promises.writeFile(fairFile, fairBody.join('\n') + '\n');
    const firstRetry = await collect(readCodex({...base,file:fairFile,checkpoint:fairCheckpoint,lookback:0,maxRecords:2}));
    fairCheckpoint = {position:firstRetry.at(-1).checkpoint.position,source:firstRetry.at(-1).source};
    assert.equal(fairCheckpoint.source.coverage.repairCursor,1);
    const secondRetry = await collect(readCodex({...base,file:fairFile,checkpoint:fairCheckpoint,lookback:0,maxRecords:2}));
    assert(secondRetry.flatMap(b => b.items).some(item => item.text === 'fixed second'));
    assert(secondRetry.at(-1).source.coverage.gaps.some(g => g.coordinate === 1 && g.reason === 'invalid-json'));
    assert(!secondRetry.at(-1).source.coverage.gaps.some(g => g.coordinate === 2 && g.reason === 'invalid-json'));
    console.log('adapter tests passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
