'use strict';

const { join } = require('node:path');
const { mkdir, lstat, open, rename, rm, readFile } = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const { decisionBoundaries } = require('./query.cjs');
const { semanticQueueFromSummaries } = require('./semantic-queue.cjs');
const { withWriterLock } = require('./lock.cjs');
const { openStorage } = require('./storage.cjs');

const knownDraftReasons = new Set([
  'INVALID_INPUT', 'LOCAL_FAILED', 'LOCAL_UNSUPPORTED', 'LOCAL_VALIDATION_OR_CACHE_FAILED',
  'MODEL_CHANGED', 'MODEL_INVALID', 'MODEL_NOT_PREPARED', 'MODEL_UNAVAILABLE',
  'SANDBOX_UNVERIFIED', 'MEMORY_ADMISSION', 'MEMORY_PRESSURE', 'MEMORY_UNAVAILABLE',
  'RSS_LIMIT', 'RSS_UNAVAILABLE', 'TIME_LIMIT', 'OUTPUT_LIMIT', 'DIAGNOSTIC_LIMIT', 'PROCESS_FAILED'
]);

async function ingestManifest(manifest, ingest) {
  if (!Array.isArray(manifest) || manifest.length > 200) throw new Error('Invalid daily manifest.');
  const run = { sourcesAttempted: 0, sourcesFailed: 0, itemsImported: 0 };
  for (const input of manifest) {
    run.sourcesAttempted++;
    try {
      const result = await ingest(input);
      run.itemsImported += result.itemsImported;
      run.sourcesFailed += Number(Boolean(result.sessionsFailed || result.inaccessible || result.blocked || result.unverifiable || result.traversalLimited));
      if (input.archiveRoot) {
        run.blocked = (run.blocked || 0) + (result.blocked || 0);
        run.unverifiable = (run.unverifiable || 0) + (result.unverifiable || 0);
      }
    } catch {
      run.sourcesFailed++;
    }
  }

  return run;
}

async function dailyReview(op, manifest, ingest, { now = Date.now, localDraft = false, localDraftRunner } = {}) {
  const run = await ingestManifest(manifest, ingest);
  const key = createHash('sha256').update(JSON.stringify(op.scope)).digest('hex');
  const status = await withWriterLock(op.archive.dir, 'derived:' + key, () => writeDaily(op, run, key, now));
  const result = {...status, localModelCalls:0, externalModelCalls:0};
  if (!localDraft) return result;
  let draft;
  try {
    const runner = localDraftRunner || require('./local-derive.cjs').runLocalDerive;
    draft = await runner({dir:op.archive.dir,owner:op.scope.owner,project:op.scope.project});
    result.localModelCalls = draft?.modelCalls === 1 ? 1 : 0;
    result.localDraftStatus = ['validated','retryable','no-eligible-messages','input-limit'].includes(draft?.status) ? draft.status : 'retryable';
    if (result.localDraftStatus === 'retryable' && knownDraftReasons.has(draft?.reason)) {
      result.localDraftReason = draft.reason;
    }
    if (result.localDraftStatus === 'validated') {
      if (typeof draft.cacheHit === 'boolean') result.localDraftCacheHit = draft.cacheHit;
      if (Number.isSafeInteger(draft.candidates) && draft.candidates >= 0 && draft.candidates <= 4) result.localDraftCandidates = draft.candidates;
      if (Number.isSafeInteger(draft.exactReferences) && draft.exactReferences >= 0 && draft.exactReferences <= 100) result.localDraftReferences = draft.exactReferences;
    }
    if (Number.isSafeInteger(draft?.inputs) && draft.inputs >= 0 && draft.inputs <= 5) result.localDraftInputs = draft.inputs;
    const availability = {};
    for (const key of ['archived','unavailableConsidered','skippedProjectionConsidered']) {
      if (Number.isSafeInteger(draft?.availability?.[key]) && draft.availability[key] >= 0 &&
          draft.availability[key] <= 1000) availability[key] = draft.availability[key];
    }
    if (Object.keys(availability).length) result.localDraftAvailability = availability;
    const stats = {};
    for (const k of ['wallSeconds','peakObservedRssMiB','promptTokens','generationRuns']) if (Number.isFinite(draft?.stats?.[k]) && draft.stats[k] >= 0) stats[k] = draft.stats[k];
    if (Object.keys(stats).length) result.localDraftStats = stats;
  } catch {
    result.localDraftStatus = 'retryable';
    result.localModelCallCountVerified = false;
    result.localDraftReason = 'LOCAL_DRAFT_ENTRY_FAILED';
  }
  try {
    const safe = {at:new Date(now()).toISOString(),status:result.localDraftStatus,localModelCalls:result.localModelCalls,externalModelCalls:0};
    for (const k of ['localDraftReason','localDraftCacheHit','localDraftCandidates','localDraftReferences','localDraftStats','localModelCallCountVerified','localDraftInputs','localDraftAvailability']) if (Object.hasOwn(result,k)) safe[k]=result[k];
    await withWriterLock(op.archive.dir,'local-draft-status:' + key,async()=>{
      const {dir}=await openStorage({dir:join(op.archive.dir,'derived'),readOnly:true});
      const target=join(dir,'local-draft-' + key + '.json'), temp=join(dir,'.local-draft-' + randomUUID() + '.tmp');
      try { const fd=await open(temp,'wx',0o600); try { await fd.writeFile(JSON.stringify(safe)); await fd.sync(); } finally { await fd.close(); } await rename(temp,target); }
      finally { await rm(temp,{force:true}); }
    });
  } catch {
    result.localDraftStatus = 'retryable';
    result.localDraftReason = 'LOCAL_DRAFT_STATUS_WRITE_FAILED';
  }
  return result;
}

async function writeDaily(op, run, key, now) {
  const items = await op.archive.listVersionSummaries(op.scope);
  const annotations = await op.archive.listAnnotations(op.scope);
  const { pending, stats: semantic } = semanticQueueFromSummaries(items);
  const at = new Date(now());
  const boundaries = decisionBoundaries(await op.archive.listItems(op.scope, {reviewOnly:true}), annotations);
  const next = boundaries.findIndex(time => time > at.getTime());
  const status = {
    at: at.toISOString(),
    next_transition: next < 0 ? null : new Date(boundaries[next]).toISOString(),
    ...run,
    archivedVersions: items.length,
    annotations: annotations.length,
    ...semantic,
    candidateSkills: 'no-evidence-backed-candidates'
  };
  const dir = join(op.dir, 'derived');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('Derived directory must be private.');
  const target = join(dir, `${key}.json`);
  let previous;
  try { previous = JSON.parse(await readFile(target, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([
    'derived-v3',
    next < 0 ? boundaries.length : next,
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
  const wiki = await op.current({ asOf: status.at });
  status.indexedTopics = topics.length;
  status.wikiEntries = wiki.length;
  status.snapshotChanged = true;
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
