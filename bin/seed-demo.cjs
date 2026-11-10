#!/usr/bin/env node
'use strict';

const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { openArchive } = require('../lib/archive.cjs');
const { readDsh } = require('../lib/adapters');

async function seed(dir) {
  if (!dir) throw new Error('Pass a directory outside Git for the synthetic demo.');
  const archive = await openArchive({ dir });
  const scope = { owner: 'local', project: 'demo' };
  const work = await mkdtemp(join(tmpdir(), 'memory-lab-demo-input-'));
  const topics = [
    ['Release checklist', 'Release stays on Tuesday.', 'Prepare the release checklist.'],
    ['Release comms', 'Draft the internal release announcement.'],
    ['Release roll-out', 'Use staged rollout for the demo release.'],
    ['Release metrics', 'Review the sample release report.'],
    ['Release bug triage', 'Sort the synthetic release issues.'],
    ['Release docs', 'Update the demo release notes.']
  ];
  try {
    for (const [index, [topic, decision, todo]] of topics.entries()) {
      const messages = [decision, ...(todo ? [todo] : [])];
      const file = join(work, 'session.jsonl');
      await writeFile(file, messages.map((text, i) => JSON.stringify({
        type: 'user/message', seq: i + 1, time: `2026-01-0${6 - index}T10:00:00Z`,
        data: { role: 'user', id: `synthetic-${i}`, turn: '1', text }
      })).join('\n') + '\n', { mode: 0o600 });
      for await (const batch of readDsh({ ...scope, instance: 'synthetic', session: topic, file })) {
        const previous = await archive.getCheckpoint({ ...scope, ...batch.source });
        if (previous) continue;
        await archive.importBatch(batch);
        const records = await archive.listItems(scope);
        for (const [i, item] of batch.items.entries()) {
          const record = records.find(r => r.item.id === item.id && r.source.session === batch.source.session);
          await archive.addAnnotation({
            scope, id: `demo-review-${index}-${i}`, kind: i === 0 ? 'decision' : 'todo',
            text: messages[i], topic,
            target: { id: item.id, revision: record.versionId }
          });
        }
      }
    }
    console.log('Synthetic demo ready in project demo. Search for Release.');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
seed(process.argv[2]).catch(() => { console.error('Demo setup failed. Use a private directory outside Git.'); process.exitCode = 1; });
