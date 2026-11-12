'use strict';
const {lstat} = require('node:fs/promises');
const {join} = require('node:path');
const {openStorage, canonical, digest} = require('./storage.cjs');
const {checkpointRevision} = require('./checkpoint.cjs');
const {versionSummary} = require('./semantic-queue.cjs');
const {matchesTime} = require('./query-time.cjs');
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`); }
function required(value, name) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`); }
function key(...parts) { return JSON.stringify(parts); }
function validJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJson);
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(validJson);
}
function validateScope(scope) { object(scope, 'scope'); required(scope.owner, 'owner'); required(scope.project, 'project'); }
function validateSource(source) { object(source, 'source'); for (const k of ['harness','instance','session']) required(source[k], k); }
function checkpointKey(scope, source) { return key(scope.owner,scope.project,source.harness,source.instance,source.session); }
function versionDigest(record) {
  const source = {...record.source}; delete source.coverage;
  const item = {...record.item}; delete item.observedAt;
  return digest({scope:record.scope,source,item});
}
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [,year,month,day,hour,minute,second,zone] = m;
  const days = new Date(Date.UTC(+year, +month, 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59) return false;
  if (zone !== 'Z' && (+zone.slice(1,3) > 23 || +zone.slice(4,6) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
function validateAnnotation(input, rows, {allowLegacyCorrectionTime = false, allowLegacyNonIndependent = false} = {}) {
  object(input,'annotation'); if (!validJson(input)) throw new Error('annotation must contain JSON data');
  validateScope(input.scope); required(input.id,'annotation.id'); required(input.text,'annotation.text');
  if (input.text.length > 16384) throw new Error('Invalid annotation');
  if (input.kind==='task-state') {
    if ((input.owner !== undefined && input.owner !== input.scope.owner) || (input.project !== undefined && input.project !== input.scope.project)) throw new Error('Annotation scope mismatch');
    return require('./task-state.cjs').validateTaskState(input,rows,{validTimestamp});
  }
  if (!['note','annotation','correction','change','decision','todo'].includes(input.kind)) throw new Error('Invalid annotation');
  if (Object.keys(input).some(k => !['id','scope','owner','project','kind','text','target','topic','basis','revises','lifecycle','valid_time','evidence','candidateReview'].includes(k))) throw new Error('Invalid annotation fields');
  if ((input.owner !== undefined && input.owner !== input.scope.owner) || (input.project !== undefined && input.project !== input.scope.project)) throw new Error('Annotation scope mismatch');
  if (input.topic !== undefined && (typeof input.topic !== 'string' || input.topic.length > 512)) throw new Error('Invalid annotation topic');
  if (input.basis !== undefined && !['confirmed','proposed','uncertain'].includes(input.basis)) throw new Error('Invalid annotation basis');
  if (input.lifecycle !== undefined && !['active','superseded','cancelled'].includes(input.lifecycle)) throw new Error('Invalid annotation lifecycle');
  if (!allowLegacyCorrectionTime && input.kind === 'correction' && Object.hasOwn(input,'valid_time')) throw Object.assign(new Error('Corrections take effect immediately and cannot have valid_time'), {code:'CORRECTION_EFFECTIVE_TIME'});
  if (input.valid_time !== undefined && !validTimestamp(input.valid_time)) throw new Error('Invalid annotation valid_time');
  if (['correction','change'].includes(input.kind)) {
    required(input.revises,'annotation.revises');
    const previous = rows.getAnnotation(key(input.scope.owner,input.scope.project,input.revises));
    if (!previous || !['decision','change'].includes(previous.kind) || previous.id === input.id) throw new Error('Review target not found or invalid');
    if (input.topic !== undefined && previous.topic !== undefined && input.topic !== previous.topic) throw new Error('Review topic mismatch');
    if (input.kind === 'correction' && (input.target?.id !== previous.target?.id || input.target?.revision !== previous.target?.revision)) throw new Error('Correction evidence mismatch');
  } else if (input.revises !== undefined) throw new Error('Only corrections and changes can revise a review');
  if (input.evidence !== undefined) {
    if (input.kind !== 'correction') throw new Error('Correction evidence is only allowed for corrections');
    object(input.evidence,'annotation.evidence'); required(input.evidence.id,'evidence.id'); required(input.evidence.revision,'evidence.revision');
    if (Object.keys(input.evidence).some(k => !['id','revision','source'].includes(k))) throw new Error('Invalid correction evidence');
    const evidence = rows.findVersion(input.scope,input.evidence.id,input.evidence.revision);
    if (Object.hasOwn(input.evidence,'source')) validateSource(input.evidence.source);
    if (!evidence || (Object.hasOwn(input.evidence,'source') && checkpointKey(evidence.scope,evidence.source) !== checkpointKey(evidence.scope,input.evidence.source))) throw new Error('Correction evidence revision not found');
    const target = typeof input.target?.id === 'string' && typeof input.target?.revision === 'string' ? rows.findVersion(input.scope,input.target.id,input.target.revision) : null;
    if (!allowLegacyNonIndependent && target && evidence.item.id === target.item.id && evidence.versionId === target.versionId && checkpointKey(evidence.scope,evidence.source) === checkpointKey(target.scope,target.source)) throw new Error('Correction evidence is not independent');
  }
  object(input.target,'annotation.target'); required(input.target.id,'target.id'); required(input.target.revision,'target.revision');
  if (Object.keys(input.target).some(k => !['id','revision','source'].includes(k))) throw new Error('Invalid annotation target');
  const found = rows.findVersion(input.scope, input.target.id, input.target.revision);
  if (Object.hasOwn(input.target,'source')) validateSource(input.target.source);
  if (!found || (Object.hasOwn(input.target,'source') && checkpointKey(found.scope,found.source) !== checkpointKey(found.scope,input.target.source))) throw new Error('Annotation target revision not found');
  if(input.candidateReview!==undefined){
    const {validateCapsule,hash}=require('./generated/candidate-review-contract.cjs'),c=validateCapsule(input.candidateReview);
    if(!['decision','todo'].includes(input.kind)||input.kind!==c.candidate.kind||(input.kind==='decision'?!['confirmed','proposed','uncertain'].includes(input.basis):input.basis!==undefined))throw Error('Invalid candidate review kind');
    const expected='candidate-review-'+hash(JSON.stringify([input.scope.owner,input.scope.project,c.snapshotSha256+':'+c.ordinal]));if(input.id!==expected)throw Error('Invalid candidate review ID');
    const primary=c.candidate.evidence[c.primary-1],parts=primary.source.split('/');
    if(parts.length!==3||!input.target.source||input.target.id!==primary.item||input.target.revision!==primary.version||['harness','instance','session'].some((k,i)=>input.target.source[k]!==parts[i]))throw Error('Candidate primary mismatch');
    for(const e of c.candidate.evidence){const ref=rows.findVersion(input.scope,e.item,e.version),source=e.source.split('/');if(!ref||source.length!==3||ref.item.kind!=='message'||!['user','assistant'].includes(ref.item.role)||!['codex','dsh'].includes(ref.source.harness)||['harness','instance','session'].some((k,i)=>ref.source[k]!==source[i]))throw Error('Candidate evidence not found');const recordType=ref.item.metadata?.recordType;if(recordType!==undefined && (typeof recordType!=='string'||!(recordType==='response_item:message'||recordType===ref.item.role+'/message'||recordType.startsWith(ref.item.role+'/message:'))))throw Error('Candidate evidence is not a message');const text=ref.item.text,q=e.originalSpan;if(typeof text!=='string'||text.slice(q.previewStartUtf16,q.previewEndUtf16)!==e.quote||ref.item.metadata?.original?.sha256!==q.originalSha256||!c.inputProjections.some(p=>{const start=q.previewStartUtf16-p.previewStartUtf16,end=q.previewEndUtf16-p.previewStartUtf16,segment=text.slice(p.previewStartUtf16,p.previewEndUtf16);return p.source===e.source&&p.item===e.item&&p.version===e.version&&p.kind===q.kind&&p.fieldPath===q.fieldPath&&p.originalSha256===q.originalSha256&&start>=0&&end<=segment.length&&end-start===e.quote.length&&q.startUtf16===p.startUtf16+start&&q.endUtf16===p.startUtf16+end&&q.startUtf8===p.startUtf8+Buffer.byteLength(segment.slice(0,start))&&q.endUtf8===p.startUtf8+Buffer.byteLength(segment.slice(0,end))}))throw Error('Invalid candidate evidence');}
  }
}
function same(a,b) { return canonical(a) === canonical(b); }
function versionKey(record) {
  const {scope,source,item} = record;
  return key(scope.owner,scope.project,source.harness,source.instance,source.session,item.id);
}

function jsonRows(state) {
  const inScope = (value, scope) => value.scope.owner === scope.owner && value.scope.project === scope.project;
  const listItems = scope => Object.values(state.versions).flat().filter(record => inScope(record,scope));
  const findItems = (scope,id,revision) => listItems(scope)
    .filter(record => record.item.id === id && (revision === undefined || record.versionId === revision));
  return {
    getBatch: id => state.batches[id],
    putBatch: (id,position) => { state.batches[id] = {position}; },
    getCheckpoint: k => state.checkpoints[k] || null,
    putCheckpoint: (k,record) => { state.checkpoints[k] = record; },
    hasVersion: (revision,k) => (state.versions[k] || []).some(record => record.versionId === revision),
    putVersion: (k,record) => { (state.versions[k] ||= []).push(record); },
    getAnnotation: k => state.annotations[k],
    putAnnotation: (k,record) => { state.annotations[k] = record; },
    listItems,
    findItems,
    findVersion: (scope,id,revision) => findItems(scope,id,revision)[0] || null,
    listSources: scope => Object.values(state.checkpoints).filter(record => inScope(record,scope)),
    listAnnotations: (scope,target) => Object.values(state.annotations).filter(record => inScope(record,scope) && (!target || (record.target?.id === target.id && record.target?.revision === target.revision))),
    listAnnotationsForTargets: (scope,targets) => {
      const keys = new Set(targets.map(t => JSON.stringify([t.id,t.revision])));
      return Object.values(state.annotations).filter(a =>
        inScope(a,scope) && keys.has(JSON.stringify([a.target?.id,a.target?.revision]))
      );
    }
  };
}

async function sqlitePresent(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function openArchive(options = {}) {
  const local = await openStorage(options);
  const sqliteFile = join(local.dir,'archive.sqlite3');
  const sqlite = await sqlitePresent(sqliteFile);
  const store = sqlite ? await require('./storage-sqlite.cjs').openSqlite({dir:local.dir,readOnly:options.readOnly}) : null;
  async function readRows(fn) {
    if (store) return fn(store);
    const state = await local.read();
    if (await sqlitePresent(sqliteFile)) throw new Error('Archive index changed; reopen the archive');
    return fn(jsonRows(state));
  }
  function transaction(fn) {
    if (store) return store.transaction(fn);
    return local.transaction(async state => {
      if (await sqlitePresent(sqliteFile)) throw new Error('Archive index changed; reopen the archive');
      return fn(jsonRows(state));
    });
  }
  return {
    dir: local.dir,
    indexFile: sqlite ? sqliteFile : join(local.dir,'archive.json'),
    backend: sqlite ? 'sqlite' : 'json',
    async sync({owner, project, url = options.couchUrl, authorization, fetchImpl, mode = 'all'} = {}) {
      validateScope({owner,project});
      if (!url) throw new Error('CouchDB URL is required');
      if (!['all','annotations','pull'].includes(mode)) throw new Error('Invalid sync mode');
      const scope = {owner,project};
      const inScope = r => r.scope.owner === owner && r.scope.project === project;
      const couch = require('./storage-couch.cjs');
      const outbound = mode === 'pull' ? [] : await readRows(rows => [
        ...(mode === 'all' ? rows.listItems(scope).map(record => ({kind:'version',record})) : []),
        ...rows.listAnnotations(scope).map(record => ({kind:'annotation',record}))
      ]);
      const sent = await couch.pushImmutable({url,documents:outbound,authorization,fetchImpl});
      const received = await couch.pullImmutable({url,authorization,fetchImpl,validate(payload) {
        object(payload,'payload'); if (!validJson(payload) || !['version','annotation'].includes(payload.kind)) throw new Error('Invalid archive payload');
        const r = payload.record; object(r,'record'); validateScope(r.scope);
        if (!inScope(r)) throw new Error('Remote document outside requested scope');
        if (payload.kind === 'version') {
          validateSource(r.source); object(r.item,'item'); required(r.item.id,'item.id'); required(r.item.kind,'item.kind');
          if (r.versionId !== versionDigest(r)) throw new Error('Invalid version ID');
          if (Object.keys(r).some(k => !['versionId','scope','source','item'].includes(k))) throw new Error('Invalid version fields');
        } else required(r.id,'annotation.id');
      }});
      const merged = await transaction(rows => {
        let count = 0;
        const existingAnnotations = new Set();
        for (const {kind,record:r} of received) if (kind === 'annotation') {
          const k = key(r.scope.owner,r.scope.project,r.id);
          if (rows.getAnnotation(k)) existingAnnotations.add(k);
        }
        for (const {kind,record:r} of received.sort((a,b) => (a.kind === 'version' ? 0 : 1) - (b.kind === 'version' ? 0 : 1))) {
          if (kind === 'version') {
            const k = versionKey(r);
            if (!rows.hasVersion(r.versionId,k)) { rows.putVersion(k,r); count++; }
          } else {
            const k = key(r.scope.owner,r.scope.project,r.id), old = rows.getAnnotation(k);
            if (old && !same(old,r)) throw new Error('Annotation ID conflict');
            if (!old) { rows.putAnnotation(k,r); count++; }
          }
        }
        // Validate after staging the whole batch so hash/page order does not affect references.
        for (const {kind,record:r} of received) if (kind === 'annotation') validateAnnotation(r,rows,{allowLegacyCorrectionTime:true,allowLegacyNonIndependent:existingAnnotations.has(key(r.scope.owner,r.scope.project,r.id))});
        const active = new Set(), done = new Set();
        function visit(a) {
          const k = key(a.scope.owner,a.scope.project,a.id);
          if (active.has(k)) throw new Error('Review revision cycle');
          if (done.has(k)) return;
          active.add(k);
          if (a.revises) { const parent = rows.getAnnotation(key(a.scope.owner,a.scope.project,a.revises)); if (parent) visit(parent); }
          if (a.kind==='task-state') for(const id of a.parents){const parent=rows.getAnnotation(key(a.scope.owner,a.scope.project,id));if(parent)visit(parent)}
          active.delete(k); done.add(k);
        }
        for (const {kind,record:r} of received) if (kind === 'annotation') visit(r);
        return count;
      });
      return {...sent,pulled:merged};
    },
    async importBatch(batch) {
      object(batch, 'batch'); if (!validJson(batch)) throw new Error('batch must contain JSON data');
      validateScope(batch.scope); validateSource(batch.source); object(batch.checkpoint, 'checkpoint');
      if (!Object.hasOwn(batch.checkpoint,'position') || batch.checkpoint.position === null) throw new Error('checkpoint.position is required');
      if (!Array.isArray(batch.items)) throw new Error('items must be an array');
      for (const item of batch.items) { object(item,'item'); required(item.id,'item.id'); required(item.kind,'item.kind'); }
      const batchId = digest(batch);
      return transaction(rows => {
        const ck = checkpointKey(batch.scope,batch.source);
        const replay = rows.getBatch(batchId);
        if (replay) return {imported:0, checkpoint:replay.position, replayed:true};
        const current = rows.getCheckpoint(ck);
        const previous = Object.hasOwn(batch.checkpoint,'previous') ? batch.checkpoint.previous : null;
        if (!same(current?.position ?? null, previous)) throw new Error('Checkpoint conflict');
        if (Object.hasOwn(batch.checkpoint, 'previousRevision')) {
          if (checkpointRevision(current) !== batch.checkpoint.previousRevision) throw new Error('Checkpoint revision conflict');
        } else if (current && same(current.position, batch.checkpoint.position) && !same(current.source, batch.source)) {
          throw new Error('Checkpoint revision required for a same-position coverage update');
        }
        let imported = 0;
        for (const item of batch.items) {
          const record = {scope:batch.scope,source:batch.source,item};
          const identity = versionKey(record);
          const versionId = versionDigest(record);
          if (!rows.hasVersion(versionId,identity)) { rows.putVersion(identity,{versionId,...record}); imported++; }
        }
        rows.putCheckpoint(ck,{scope:batch.scope,source:batch.source,position:batch.checkpoint.position});
        rows.putBatch(batchId,batch.checkpoint.position);
        return {imported,checkpoint:batch.checkpoint.position,replayed:false};
      });
    },
    async listItems({owner,project}, filters) {
      const scope = {owner,project}; validateScope(scope);
      return readRows(rows => rows.listItems(scope,filters));
    },
    async topicSources(scope, filters, cursor, limit) {
      validateScope(scope);
      return readRows(rows => {
        if (rows.topicSources) return rows.topicSources(scope,filters,cursor,limit);
        // JSON is loaded in full. Sort immutable version IDs and invalidate a cursor
        // when the scoped version set changes, so insertions cannot be skipped.
        const all=rows.listItems(scope), fingerprint=digest(all.map(r=>r.versionId).sort());
        if (cursor && cursor.fingerprint !== fingerprint) throw new Error('Source cursor is stale');
        const matching=all.filter(r=>{
          const i=r.item,m=i.metadata || {},name=String(m.topic || (r.source ? [r.source.harness,r.source.instance,r.source.session].join(' / ') : i.title || i.id));
          return name===filters.topic && matchesTime(i.timestamp || i.time || i.valid_time || i.created_at || '',filters);
        }).sort((a,b)=>a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0).filter(r=>!cursor || r.versionId>cursor.after);
        const page=matching.slice(0,limit), more=matching.length>limit;
        return {records:page.map(r=>({versionId:r.versionId,scope:r.scope,source:r.source,item:{id:r.item.id,time:r.item.timestamp || r.item.time || r.item.valid_time || r.item.created_at || '',metadata:{topic:filters.topic}}})),next:more?{after:page.at(-1).versionId,fingerprint}:null};
      });
    },
    async listVersionSummaries(scope) {
      validateScope(scope);
      return readRows(rows => rows.listVersionSummaries
        ? rows.listVersionSummaries(scope)
        : rows.listItems(scope).map(versionSummary));
    },
    async localDeriveMessages(scope) {
      validateScope(scope);
      if (!store) throw Object.assign(new Error('Local derivation requires a migrated archive'), {code:'SQLITE_REQUIRED'});
      return store.localDeriveMessages(scope);
    },
    async localDraftFence(scope) {
      validateScope(scope);
      if (!store) throw Object.assign(new Error('Local derivation requires a migrated archive'),{code:'SQLITE_REQUIRED'});
      return store.localDraftFence();
    },
    async localDraftAnchor(scope,seq) {
      validateScope(scope);
      if (!store) throw Object.assign(new Error("Local derivation requires a migrated archive"),{code:"SQLITE_REQUIRED"});
      if (!Number.isSafeInteger(seq)||seq<0) throw new Error("Invalid local draft anchor");
      return store.localDraftAnchor(seq);
    },
    async localDraftPage(scope,after,fence,limit) {
      validateScope(scope);
      if (!store) throw Object.assign(new Error('Local derivation requires a migrated archive'),{code:'SQLITE_REQUIRED'});
      if (![after,fence,limit].every(Number.isSafeInteger) || after<0 || fence<after || limit<1 || limit>100) throw new Error('Invalid local draft page');
      return store.localDraftPage(scope,after,fence,limit);
    },
    async getItem({owner,project,id,revision,source}) {
      const scope = {owner,project}; validateScope(scope); required(id,'id');
      if (source !== undefined) validateSource(source);
      if (revision !== undefined) { required(revision,'revision'); const record = await readRows(rows => rows.findVersion(scope,id,revision)); return record && (!source || checkpointKey(scope,record.source) === checkpointKey(scope,source)) ? record : null; }
      const matches = (await readRows(rows => rows.findItems(scope,id))).filter(record => !source || checkpointKey(scope,record.source) === checkpointKey(scope,source));
      if (!matches.length) return null;
      const sources = new Set(matches.map(v => checkpointKey(v.scope,v.source)));
      if (sources.size > 1) throw new Error('Ambiguous item ID across sources');
      return matches[matches.length - 1];
    },
    async lookupDraftEvidence({owner,project,id,revision,source}) {
      const scope={owner,project}; validateScope(scope); validateSource(source);
      required(id,'id'); required(revision,'revision');
      if (!store) throw Object.assign(new Error('Draft evidence requires a migrated archive'), {code:'SQLITE_REQUIRED'});
      return store.findDraftEvidence(scope,source,id,revision,versionKey({scope,source,item:{id}}));
    },
    async listSources({owner,project}) {
      const scope = {owner,project}; validateScope(scope);
      return readRows(rows => rows.listSources(scope));
    },
    async getCheckpoint({owner,project,harness,instance,session}) {
      const scope = {owner,project}, source = {harness,instance,session}; validateScope(scope); validateSource(source);
      return readRows(rows => rows.getCheckpoint(checkpointKey(scope,source)) || null);
    },
    async addAnnotation(input) {
      return transaction(rows => {
        if(input?.kind==='task-state'){
          const k=key(input.scope?.owner,input.scope?.project,input.id),existing=rows.getAnnotation(k);
          if(existing){const {recordedAt,...old}=existing;if(!same(old,input)&&!same(existing,input))throw Error('Annotation ID conflict');return existing}
          if(Object.hasOwn(input,'recordedAt'))throw Error('recordedAt is system assigned');
          const record={...input,recordedAt:new Date().toISOString()};validateAnnotation(record,rows);require('./task-state.cjs').checkNewParents(record,rows);rows.putAnnotation(k,record);return record;
        }
        const k = key(input.scope.owner,input.scope.project,input.id), existing = rows.getAnnotation(k);
        if(input.candidateReview!==undefined){
          if(!input.candidateReview||typeof input.candidateReview!=='object'||Array.isArray(input.candidateReview)||Object.hasOwn(input.candidateReview,'reviewedAt'))throw Error('reviewedAt is system assigned');
          if(existing){const {reviewedAt,...prior}=existing.candidateReview||{};if(!same({...existing,candidateReview:prior},input))throw Error('Annotation ID conflict');return existing}
          const record={...input,candidateReview:{...input.candidateReview,reviewedAt:new Date().toISOString()}};validateAnnotation(record,rows);rows.putAnnotation(k,record);return record;
        }
        if (existing && !same(existing,input)) throw new Error('Annotation ID conflict');
        validateAnnotation(input,rows,{allowLegacyNonIndependent:Boolean(existing)});
        if (!existing) rows.putAnnotation(k,input);
        return input;
      });
    },
    async getAnnotation({owner,project,id}) { const scope={owner,project};validateScope(scope);required(id,'id');return readRows(rows=>{const record=rows.getAnnotation(key(owner,project,id))||null;if(record && (record.scope?.owner!==owner || record.scope?.project!==project || record.id!==id))throw Error('Annotation identity mismatch');if(record?.candidateReview)validateAnnotation(record,rows,{allowLegacyCorrectionTime:true,allowLegacyNonIndependent:true});return record}); },
    async listAnnotations({owner,project}, target) { const scope = {owner,project}; validateScope(scope); return readRows(rows => rows.listAnnotations(scope,target)); },
    async listAnnotationsForTargets({owner,project}, targets) { const scope={owner,project}; validateScope(scope); return readRows(rows=>rows.listAnnotationsForTargets(scope,targets)); }
  };
}
module.exports = {openArchive,versionDigest};
