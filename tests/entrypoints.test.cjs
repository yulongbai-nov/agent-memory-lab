'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { openStorage } = require('../lib/storage.cjs');

const cli = join(__dirname, '..', 'bin', 'memory.cjs');
function run(args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }));
}

test('CLI and MCP discovery, exact evidence, and late review refresh', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-lab-entrypoints-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(__dirname, '..', 'bin', 'seed-demo.cjs'), dir]);
  const args = ['--dir', dir, '--project', 'demo'];
  const client = new Client({ name: 'synthetic-ci', version: '0.1.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [cli, 'mcp', ...args], stderr: 'ignore'
  }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert(tools.includes('memory_evidence'));
  assert(!tools.includes('memory_annotate') && !tools.includes('import'));
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined);
    return JSON.parse(result.content[0].text);
  }
  const found = await call('memory_find', { keyword: 'Release', limit: 5 });
  assert.equal(found.topics.length, 5);
  assert(found.topics.some(topic => topic.topic === 'Release checklist'));
  const { rows } = await call('memory_timeline', { topic: 'Release checklist' });
  const todo = rows.find(row => row.kind === 'todo');
  assert.equal(todo.next_step, 'Prepare the release checklist.');
  const evidence = await call('memory_evidence', todo.citation);
  assert.equal(evidence.text, todo.next_step);
  assert.equal(evidence.revision, todo.citation.revision);
  assert((await client.callTool({ name: 'memory_evidence', arguments: { ...todo.citation, project: 'other' } })).isError);

  const initial = run(['daily', ...args]);
  const replay = run(['daily', ...args]);
  assert.equal(initial.archivedVersions, replay.archivedVersions);
  assert.equal(replay.modelCalls, 0);
  assert.equal(replay.newlyQueued, 0);
  assert.equal(replay.snapshotChanged, false);
  const decision = rows.find(row => row.kind === 'decision');
  run(['annotate', ...args, '--kind', 'correction', '--target', JSON.stringify(decision.citation),
    '--id', 'late-synthetic-correction', '--revises', decision.review_id, '--text', 'Tuesday at noon.']);
  const refreshed = run(['daily', ...args]);
  assert.equal(refreshed.annotations, initial.annotations + 1);
  assert.equal(refreshed.snapshotChanged, true);
  const [snapshot] = await readdir(join(dir, 'derived'));
  const { wiki } = JSON.parse(await readFile(join(dir, 'derived', snapshot), 'utf8'));
  assert.equal(wiki.find(row => row.topic === 'Release checklist').text, 'Tuesday at noon.');
  assert.equal((await call('memory_evidence', decision.citation)).text, 'Release stays on Tuesday.');
});

test('runtime refuses private storage inside the worktree', async () => {
  await assert.rejects(openStorage({ dir: join(__dirname, '..', 'forbidden-runtime') }), /outside Git/);
});

test('daily refreshes the Wiki at the effective instant without another write', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-lab-clock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(__dirname, '..', 'bin', 'seed-demo.cjs'), dir]);
  const args = ['--dir', dir, '--project', 'demo'];
  const before = run(['current', ...args, '--topic', 'Release checklist'])[0];
  const boundary = '2030-02-01T00:00:00.123900Z';
  run(['annotate', ...args, '--kind', 'change', '--target', JSON.stringify(before.citation),
    '--id', 'synthetic-future-change', '--revises', before.review_id, '--valid-time', boundary,
    '--topic', 'Release checklist', '--text', 'Release moves to Wednesday.']);
  const { operations } = require('../lib/operations.cjs');
  const { dailyReview } = require('../lib/daily.cjs');
  const op = await operations({ dir, project: 'demo' });
  const noImport = () => { throw Error('No imports expected'); };
  const refresh = now => dailyReview(op, [], noImport, { now: () => new Date(now) });
  const first = await refresh('2030-02-01T00:00:00.123Z');
  const [snapshot] = await readdir(join(dir, 'derived'));
  const wikiText = async () => {
    const { wiki } = JSON.parse(await readFile(join(dir, 'derived', snapshot), 'utf8'));
    return wiki.find(row => row.topic === 'Release checklist').text;
  };
  assert.equal(await wikiText(), 'Release stays on Tuesday.');
  assert.equal(first.next_transition, '2030-02-01T00:00:00.1239Z');
  assert.equal((await refresh('2030-02-01T00:00:00.123Z')).snapshotChanged, false);
  const activated = await refresh('2030-02-01T00:00:00.124Z');
  assert.equal(activated.snapshotChanged, true);
  assert.equal(activated.next_transition, null);
  assert.equal(activated.annotations, first.annotations);
  assert.equal(activated.archivedVersions, first.archivedVersions);
  assert.equal(await wikiText(), 'Release moves to Wednesday.');
  assert.equal((await refresh('2030-02-01T00:00:00.125Z')).snapshotChanged, false);
  const { createHash } = require('node:crypto');
  const { writeFile } = require('node:fs/promises');
  const { decisionBoundaries } = require('../lib/query.cjs');
  const snapshotPath = join(dir, 'derived', snapshot);
  const existing = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const versions = await op.archive.listVersionSummaries(op.scope);
  const annotations = await op.archive.listAnnotations(op.scope);
  const times = decisionBoundaries(await op.archive.listItems(op.scope, {reviewOnly:true}), annotations);
  const legacyFingerprint = createHash('sha256').update(JSON.stringify([
    'derived-v3', new Set(times.map(time => time.ms)).size,
    versions.map(record => record.versionId).sort(), annotations.map(record => record.id).sort()
  ])).digest('hex');
  await writeFile(snapshotPath, JSON.stringify({...existing, fingerprint: legacyFingerprint}));
  const upgraded = await refresh('2030-02-01T00:00:00.125Z');
  assert.equal(upgraded.snapshotChanged, true);
  assert.equal(upgraded.newlyQueued, 0);
  assert.deepEqual(JSON.parse(await readFile(snapshotPath, 'utf8')).pending, existing.pending);
  assert.equal((await refresh('2030-02-01T00:00:00.125Z')).snapshotChanged, false);
});

test('private originals preserve exact bytes even when redacted previews are identical', async t => {
  const { createHash } = require('node:crypto');
  const { writeFile, stat } = require('node:fs/promises');
  const { operations } = require('../lib/operations.cjs');
  const dir = await mkdtemp(join(tmpdir(), 'memory-lab-original-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'synthetic.jsonl');
  const store = join(dir, 'archive');
  const args = ['--dir', store, '--project', 'demo'];
  const record = token => Buffer.from(JSON.stringify({
    type: 'user/message', seq: 1, time: '2026-01-01T00:00:00Z',
    data: { id: 'source-one', role: 'user', text: 'hello token=' + token }
  }) + '\r\n');
  const first = record('synthetic-private-original-one');
  const second = record('synthetic-private-original-two');
  const unfamiliar = Buffer.from('{"type":"new/future-kind","seq":2,"data":{"privateField":"synthetic-private-unknown"}}\n');
  const ingest = () => run(['ingest', ...args, '--source', 'dsh', '--file', source, '--instance', 'lab', '--session', 'one']);
  await writeFile(source, Buffer.concat([first, unfamiliar]));
  assert.equal(ingest().itemsImported, 2);
  assert.equal(ingest().itemsImported, 0);
  await writeFile(source, Buffer.concat([second, unfamiliar]));
  assert.equal(ingest().itemsImported, 1);
  assert.equal(ingest().itemsImported, 0);

  const op = await operations({ dir: store, project: 'demo' });
  const rows = await op.archive.listItems(op.scope);
  const versions = rows.filter(row => row.item.role === 'user');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].item.text, versions[1].item.text);
  assert(!JSON.stringify(rows).includes('synthetic-private'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  for (const bytes of [first, second, unfamiliar]) {
    const id = digest(bytes);
    const item = rows.find(row => row.item.metadata.original.sha256 === id);
    assert(item);
    const file = join(store, 'originals', id + '.jsonl');
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const lookup = ['--id', item.item.id, '--revision', item.versionId];
    const evidence = run(['evidence', ...args, ...lookup]);
    assert.equal(evidence.original.sha256, id);
    assert.equal(evidence.original.availability, 'archived');
    assert(!JSON.stringify(evidence).includes('synthetic-private'));
    const verified = run(['verify-original', ...args, ...lookup]);
    assert.equal(verified.verified, true);
    assert.equal(verified.bytes, bytes.length);
  }
  assert.equal((await readdir(join(store, 'originals'))).length, 3);
  await rm(join(store, 'originals', digest(first) + '.jsonl'));
  const old = versions[0];
  assert.equal((await op.evidence({ id: old.item.id, revision: old.versionId })).original.availability, 'missing-locally');
});

test('overlapping daily writers publish the newer derived view last', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-lab-daily-serialize-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(__dirname, '..', 'bin', 'seed-demo.cjs'), dir]);
  const { operations } = require('../lib/operations.cjs');
  const { dailyReview } = require('../lib/daily.cjs');
  const { setTimeout: delay } = require('node:timers/promises');
  const op = await operations({ dir, project: 'demo' });
  const original = (await op.current({ topic: 'Release checklist' }))[0];
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const noImport = () => { throw Error('No imports expected'); };
  const oldRun = dailyReview({
    ...op,
    async current(args) {
      const stale = await op.current(args);
      entered.resolve();
      await release.promise;
      return stale;
    }
  }, [], noImport);

  let newRun;
  try {
    await entered.promise;
    await op.annotate({
      target: original.citation, kind: 'correction', id: 'synthetic-overlap',
      revises: original.review_id, text: 'Tuesday at noon.'
    });
    let newEntered = false;
    newRun = dailyReview({
      ...op,
      async current(args) {
        newEntered = true;
        return op.current(args);
      }
    }, [], noImport);
    await delay(100);
    assert.equal(newEntered, false);
  } finally {
    release.resolve();
    await Promise.all([oldRun, newRun]);
  }
  const [snapshot] = await readdir(join(dir, 'derived'));
  const { wiki } = JSON.parse(await readFile(join(dir, 'derived', snapshot), 'utf8'));
  assert.equal(wiki.find(row => row.topic === 'Release checklist').text, 'Tuesday at noon.');
});
