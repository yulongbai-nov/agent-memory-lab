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
