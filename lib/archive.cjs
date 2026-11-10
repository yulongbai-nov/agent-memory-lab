'use strict';
const {openStorage, canonical, digest} = require('./storage.cjs');
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
function validateAnnotation(input, state, {allowLegacyCorrectionTime = false} = {}) {
  object(input,'annotation'); if (!validJson(input)) throw new Error('annotation must contain JSON data');
  validateScope(input.scope); required(input.id,'annotation.id'); required(input.text,'annotation.text');
  if (input.text.length > 16384 || !['note','annotation','correction','change','decision','todo'].includes(input.kind)) throw new Error('Invalid annotation');
  if (Object.keys(input).some(k => !['id','scope','owner','project','kind','text','target','topic','basis','revises','lifecycle','valid_time'].includes(k))) throw new Error('Invalid annotation fields');
  if ((input.owner !== undefined && input.owner !== input.scope.owner) || (input.project !== undefined && input.project !== input.scope.project)) throw new Error('Annotation scope mismatch');
  if (input.topic !== undefined && (typeof input.topic !== 'string' || input.topic.length > 512)) throw new Error('Invalid annotation topic');
  if (input.basis !== undefined && !['confirmed','proposed','uncertain'].includes(input.basis)) throw new Error('Invalid annotation basis');
  if (input.lifecycle !== undefined && !['active','superseded','cancelled'].includes(input.lifecycle)) throw new Error('Invalid annotation lifecycle');
  if (!allowLegacyCorrectionTime && input.kind === 'correction' && Object.hasOwn(input,'valid_time')) throw Object.assign(new Error('Corrections take effect immediately and cannot have valid_time'), {code:'CORRECTION_EFFECTIVE_TIME'});
  if (input.valid_time !== undefined && !validTimestamp(input.valid_time)) throw new Error('Invalid annotation valid_time');
  if (['correction','change'].includes(input.kind)) {
    required(input.revises,'annotation.revises');
    const previous = state.annotations[key(input.scope.owner,input.scope.project,input.revises)];
    if (!previous || !['decision','change'].includes(previous.kind) || previous.id === input.id) throw new Error('Review target not found or invalid');
    if (input.topic !== undefined && previous.topic !== undefined && input.topic !== previous.topic) throw new Error('Review topic mismatch');
    if (input.kind === 'correction' && (input.target?.id !== previous.target?.id || input.target?.revision !== previous.target?.revision)) throw new Error('Correction evidence mismatch');
  } else if (input.revises !== undefined) throw new Error('Only corrections and changes can revise a review');
  object(input.target,'annotation.target'); required(input.target.id,'target.id'); required(input.target.revision,'target.revision');
  if (Object.keys(input.target).some(k => !['id','revision','source'].includes(k))) throw new Error('Invalid annotation target');
  const found = Object.values(state.versions).flat().find(v => v.scope.owner === input.scope.owner && v.scope.project === input.scope.project && v.item.id === input.target.id && v.versionId === input.target.revision);
  if (!found || (input.target.source && checkpointKey(found.scope,found.source) !== checkpointKey(found.scope,input.target.source))) throw new Error('Annotation target revision not found');
}
function same(a,b) { return canonical(a) === canonical(b); }
async function openArchive(options = {}) {
  const storage = await openStorage(options);
  return {
    dir: storage.dir,
    async sync({owner, project, url = options.couchUrl, authorization, fetchImpl, mode = 'all'} = {}) {
      validateScope({owner,project});
      if (!url) throw new Error('CouchDB URL is required');
      if (!['all','annotations','pull'].includes(mode)) throw new Error('Invalid sync mode');
      const state = await storage.read();
      const inScope = r => r.scope.owner === owner && r.scope.project === project;
      const documents = [...Object.values(state.versions).flat().filter(inScope).map(record => ({kind:'version',record})), ...Object.values(state.annotations).filter(inScope).map(record => ({kind:'annotation',record}))];
      const couch = require('./storage-couch.cjs');
      const outbound = mode === 'pull' ? [] : mode === 'annotations' ? documents.filter(d => d.kind === 'annotation') : documents;
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
      const merged = await storage.transaction(current => {
        let count = 0;
        for (const {kind,record:r} of received.sort((a,b) => (a.kind === 'version' ? 0 : 1) - (b.kind === 'version' ? 0 : 1))) {
          if (kind === 'version') {
            const k = key(r.scope.owner,r.scope.project,r.source.harness,r.source.instance,r.source.session,r.item.id);
            const versions = current.versions[k] || [];
            if (!versions.some(v => v.versionId === r.versionId)) { versions.push(r); current.versions[k] = versions; count++; }
          } else {
            const k = key(r.scope.owner,r.scope.project,r.id), old = current.annotations[k];
            if (old && !same(old,r)) throw new Error('Annotation ID conflict');
            if (!old) { current.annotations[k] = r; count++; }
          }
        }
        // Validate after staging the whole batch so hash/page order does not affect references.
        for (const {kind,record:r} of received) if (kind === 'annotation') validateAnnotation(r,current,{allowLegacyCorrectionTime:true});
        const active = new Set(), done = new Set();
        function visit(a) {
          const k = key(a.scope.owner,a.scope.project,a.id);
          if (active.has(k)) throw new Error('Review revision cycle');
          if (done.has(k)) return;
          active.add(k);
          if (a.revises) { const parent = current.annotations[key(a.scope.owner,a.scope.project,a.revises)]; if (parent) visit(parent); }
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
      return storage.transaction(state => {
        const ck = checkpointKey(batch.scope,batch.source);
        if (state.batches[batchId]) return {imported:0, checkpoint:state.batches[batchId].position, replayed:true};
        const current = state.checkpoints[ck];
        const previous = Object.hasOwn(batch.checkpoint,'previous') ? batch.checkpoint.previous : null;
        if (!same(current?.position ?? null, previous)) throw new Error('Checkpoint conflict');
        let imported = 0;
        for (const item of batch.items) {
          const identity = key(batch.scope.owner,batch.scope.project,batch.source.harness,batch.source.instance,batch.source.session,item.id);
          const record = {scope:batch.scope,source:batch.source,item};
          const versionId = versionDigest(record);
          const versions = state.versions[identity] || [];
          if (!versions.some(v => v.versionId === versionId)) { versions.push({versionId,...record}); imported++; }
          state.versions[identity] = versions;
        }
        state.checkpoints[ck] = {scope:batch.scope,source:batch.source,position:batch.checkpoint.position};
        state.batches[batchId] = {position:batch.checkpoint.position};
        return {imported,checkpoint:batch.checkpoint.position,replayed:false};
      });
    },
    async listItems({owner,project}) {
      validateScope({owner,project}); const state = await storage.read();
      return Object.values(state.versions).flat().filter(v => v.scope.owner === owner && v.scope.project === project);
    },
    async getItem({owner,project,id,revision}) {
      required(id,'id'); const matches = (await this.listItems({owner,project})).filter(v => v.item.id === id);
      if (revision !== undefined) { required(revision,'revision'); return matches.find(v => v.versionId === revision) || null; }
      if (!matches.length) return null;
      const sources = new Set(matches.map(v => checkpointKey(v.scope,v.source)));
      if (sources.size > 1) throw new Error('Ambiguous item ID across sources');
      return matches[matches.length - 1];
    },
    async listSources({owner,project}) {
      validateScope({owner,project}); const state = await storage.read();
      return Object.values(state.checkpoints).filter(c => c.scope.owner === owner && c.scope.project === project);
    },
    async getCheckpoint({owner,project,harness,instance,session}) {
      const scope = {owner,project}, source = {harness,instance,session}; validateScope(scope); validateSource(source);
      return (await storage.read()).checkpoints[checkpointKey(scope,source)] || null;
    },
    async addAnnotation(input) {
      return storage.transaction(state => {
        validateAnnotation(input,state);
        const k = key(input.scope.owner,input.scope.project,input.id), existing = state.annotations[k];
        if (existing && !same(existing,input)) throw new Error('Annotation ID conflict');
        state.annotations[k] = input; return input;
      });
    },
    async listAnnotations({owner,project}) { validateScope({owner,project}); return Object.values((await storage.read()).annotations).filter(a => a.scope.owner === owner && a.scope.project === project); }
  };
}
module.exports = {openArchive};
