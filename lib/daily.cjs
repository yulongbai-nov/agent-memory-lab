'use strict';

const { join } = require('node:path');
const { mkdir, lstat, open, rename, rm, readFile } = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');

async function ingestManifest(manifest, ingest) {
  if (!Array.isArray(manifest) || manifest.length > 200) throw new Error('Invalid daily manifest.');
  const run = { sourcesAttempted: 0, sourcesFailed: 0, itemsImported: 0 };
  for (const input of manifest) {
    run.sourcesAttempted++;
    try {
      const result = await ingest(input);
      run.itemsImported += result.itemsImported;
      run.sourcesFailed += Number(Boolean(result.sessionsFailed || result.inaccessible));
    } catch {
      run.sourcesFailed++;
    }
  }

  return run;
}

async function dailyReview(op, manifest, ingest) {
  const run = await ingestManifest(manifest, ingest);
  const items = await op.archive.listItems(op.scope);
  const annotations = await op.archive.listAnnotations(op.scope);
  const itemsPending = items.filter(record =>
    record.item.text && record.item.role === 'user' && !record.item.metadata?.reviewed
  );
  const status = {
    at: new Date().toISOString(),
    ...run,
    archivedVersions: items.length,
    annotations: annotations.length,
    semanticStatus: itemsPending.length ? 'pending-review' : 'no-pending-items',
    semanticItemsPending: itemsPending.length,
    modelCalls: 0,
    candidateSkills: 'no-evidence-backed-candidates'
  };
  const dir = join(op.dir, 'derived');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('Derived directory must be private.');
  const key = createHash('sha256').update(JSON.stringify(op.scope)).digest('hex');
  const target = join(dir, `${key}.json`);
  let previous;
  try { previous = JSON.parse(await readFile(target, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'derived-v1',
    items.map(record => record.versionId).sort(),
    annotations.map(record => record.id).sort()
  ])).digest('hex');
  if (previous?.fingerprint === fingerprint) {
    return {
      ...status, indexedTopics: previous.index.length, wikiEntries: previous.wiki.length,
      newlyQueued: 0, snapshotChanged: false
    };
  }
  const { topics } = await op.find({ limit: 20 });
  const wiki = await op.current({});
  status.indexedTopics = topics.length;
  status.wikiEntries = wiki.length;
  status.snapshotChanged = true;
  const pending = itemsPending.map(record => record.versionId).sort();
  const previousQueue = new Set(previous?.pending || []);
  status.newlyQueued = pending.filter(id => !previousQueue.has(id)).length;
  const temp = join(dir, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ fingerprint, status, pending, index: topics, wiki, candidateSkills: [] })); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
  return status;
}

module.exports = { dailyReview, ingestManifest };
