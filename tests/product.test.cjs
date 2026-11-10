'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {openArchive} = require('../lib/archive.cjs');
const {readDsh} = require('../lib/adapters');
const {createQuery} = require('../lib/query.cjs');

test('synthetic DSH import supports bounded discovery and evidence-backed review', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-product-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'session.jsonl');
  const records = [
    {type:'turn/start',seq:1,time:'2026-01-01T09:00:00Z',data:{turn:'turn-1'}},
    {type:'message',seq:2,time:'2026-01-01T09:01:00Z',data:{id:'msg-1',role:'user',text:'The release will be on Monday.'}},
    {type:'message',seq:3,time:'2026-01-02T09:01:00Z',data:{id:'msg-2',role:'user',text:'I changed the release to Tuesday.'}},
    {type:'message',seq:4,time:'2026-01-03T09:01:00Z',data:{id:'msg-3',role:'user',text:'Correct your interpretation: I meant the test, not the launch.'}},
    {type:'message',seq:5,time:'2026-01-04T09:01:00Z',data:{id:'msg-4',role:'user',text:'TODO: prepare the release checklist.'}},
    {type:'turn/end',seq:6,time:'2026-01-04T09:02:00Z',data:{turn:'turn-1',reason:'completed'}}
  ];
  await fs.writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  const scope = {owner:'synthetic-owner',project:'synthetic-project'};
  const archive = await openArchive({dir:path.join(dir,'archive')});
  for await (const batch of readDsh({...scope,instance:'synthetic',session:'release',file,batchSize:2})) await archive.importBatch(batch);
  const query = createQuery(archive);
  const found = await query.find({...scope,keyword:'release',limit:1});
  assert.equal(found.topics.length, 1);
  assert.equal(found.coverage.returned, 1);
  const rows = await query.timeline({...scope,topic:found.topics[0].topic});
  const raw = [];
  for (const row of rows) raw.push(await query.evidence({...scope,...row.citation}));
  const original = raw.find(item => item.text === records[1].data.text);
  const changed = raw.find(item => item.text === records[2].data.text);
  const correction = raw.find(item => item.text === records[3].data.text);
  const todo = raw.find(item => item.text === records[4].data.text);
  assert(original && changed && correction && todo);
  await assert.rejects(query.evidence({...scope,id:original.id,revision:'incorrect',source:original.source}));
  await assert.rejects(query.evidence({...scope,owner:'someone-else',id:original.id,revision:original.revision,source:original.source}));
  const cited = item => ({id:item.id,revision:item.revision,source:item.source});
  await query.annotate({...scope,id:'review-interpretation',kind:'decision',text:'Release Monday',target:cited(original)});
  await query.annotate({...scope,id:'correction-1',kind:'correction',revises:'review-interpretation',text:'The earlier interpretation confused test and launch.',target:cited(original)});
  const notes = await query.annotations(scope);
  assert.equal(notes[1].kind, 'correction');
  assert.equal(notes[1].target.id, original.id);
  // Reviewed projections are explicitly supplied by a reviewer, never inferred by the adapter.
  const projectionSource = {harness:'review',instance:'synthetic',session:'release-review'};
  await archive.importBatch({scope,source:projectionSource,checkpoint:{previous:null,position:1},items:[
    {id:'decision',kind:'review',time:'2026-01-01',text:'Release Monday',metadata:{topic:'Release plan',kind:'decision',basis:'confirmed',reviewed:true,evidence:cited(original)}},
    {id:'change',kind:'review',time:'2026-01-02',text:'Release Tuesday',metadata:{topic:'Release plan',kind:'change',basis:'confirmed',reviewed:true,revises:['decision'],evidence:cited(changed)}},
    {id:'todo',kind:'review',time:'2026-01-04',text:'Prepare the release checklist',metadata:{topic:'Release plan',kind:'todo',reviewed:true,next_step:'Prepare the release checklist',evidence:cited(todo)}}
  ]});
  const timeline = await query.timeline({...scope,topic:'Release plan'});
  assert.deepEqual(timeline.map(row => row.kind), ['decision','change','todo']);
  assert.deepEqual(timeline[1].revises, ['decision']);
  assert.equal(timeline[2].next_step, 'Prepare the release checklist');
  const correctionRow = (await query.timeline(scope)).find(row => row.citation.id === original.id);
  assert.equal(correctionRow.kind, 'source');
  assert.equal(correctionRow.annotations.length, 0);
  const reviewed = (await query.timeline(scope)).find(row => row.review_id === 'review-interpretation');
  assert(reviewed.annotations.some(row => row.kind === 'correction'));
});
