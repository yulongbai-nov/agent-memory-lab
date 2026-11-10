'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {discover} = require('./discover.cjs');
const {withWriterLock} = require('./lock.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const signature = st => hash(JSON.stringify([st.size,st.mtimeMs,st.ctimeMs,st.ino]));
async function collectChanged(op,input,ingest) {
  if (!input.root || !input.instance || !['codex','dsh'].includes(input.source)) throw new Error('Invalid collector source');
  const limit = input['max-sessions'] === undefined ? 3 : Number(input['max-sessions']);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid collector limit');
  const cap = input['max-archive-mib'] === undefined ? 128 : Number(input['max-archive-mib']);
  if (!Number.isFinite(cap) || cap < 1 || cap > 65536) throw new Error('Invalid collector capacity');
  const atCapacity = async () => { try { return (await fs.stat(op.archive.indexFile || path.join(op.archive.dir,'archive.json'))).size >= cap * 1024 * 1024; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  const empty = {skippedForCapacity:false,baseline:false,skippedForBackfill:false,discovered:0,sessionsAttempted:0,sessionsFailed:0,itemsImported:0,pending:0,blocked:0,inaccessible:0,traversalLimited:false};
  const backfillMarker = 'historical-backfill-pass-v1.json.lock';
  try {
    await fs.lstat(path.join(op.archive.dir,backfillMarker));
    try {
      // A successful probe can recover a known marker left by a killed writer.
      await withWriterLock(op.archive.dir,'historical-backfill-pass-v1',() => {}, {legacyLock:backfillMarker,timeoutMs:0});
    } catch (error) {
      if (error.message === 'Writer lock wait timed out') return {...empty,skippedForBackfill:true};
      throw error;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const root = await fs.realpath(input.root);
  const sourceId = hash(JSON.stringify([op.scope.owner,op.scope.project,input.source,input.instance,root]));
  const stateFile = path.join(op.archive.dir,`collector-${sourceId}.json`);
  return withWriterLock(op.archive.dir,`collector:${sourceId}`,async () => {
    const snapshot = await discover(root,input.source,{maximum:20000,recent:true});
    const current=[]; let inaccessible=snapshot.inaccessible;
    for (const entry of snapshot.files) {
      try { const st=await fs.lstat(entry.file); if (!st.isFile() || st.isSymbolicLink()) throw new Error('source changed'); current.push({...entry,id:hash(entry.session),sig:signature(st),mtime:st.mtimeMs}); }
      catch { inaccessible++; }
    }
    let state;
    try {
      const st=await fs.lstat(stateFile); if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error('Invalid collector state');
      state=JSON.parse(await fs.readFile(stateFile,'utf8'));
      if (state.version !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries) || Object.keys(state.entries).length > 20000) throw new Error('Invalid collector state');
    } catch(error) { if (error.code !== 'ENOENT') throw error; }
    async function save() {
      const tmp=`${stateFile}.${crypto.randomUUID()}.tmp`;
      try { const f=await fs.open(tmp,'wx',0o600); try { await f.writeFile(JSON.stringify(state)); await f.sync(); } finally { await f.close(); } await fs.rename(tmp,stateFile); }
      finally { await fs.rm(tmp,{force:true}); }
    }
    const result={...empty,discovered:snapshot.discovered,inaccessible,traversalLimited:snapshot.traversalLimited};
    if (!state) {
      state={version:1,entries:Object.fromEntries(current.map(e=>[e.id,{sig:e.sig}]))};
      await save(); result.baseline=true; return result;
    }
    // Prune only after a complete scan; files that disappear from an incomplete scan retain their prior state.
    if (!snapshot.traversalLimited && !inaccessible) { const ids=new Set(current.map(e=>e.id)); for (const id of Object.keys(state.entries)) if (!ids.has(id)) delete state.entries[id]; }
    const pending=current.filter(e=>{ const old=state.entries[e.id]; return !old || ((old.sig !== e.sig || old.partial) && old.blocked !== e.sig); });
    pending.sort((a,b) => (state.entries[a.id]?.attemptedAt || 0) - (state.entries[b.id]?.attemptedAt || 0) || b.mtime - a.mtime);
    result.pending=pending.length;
    for (const entry of pending.slice(0,limit)) {
      if (await atCapacity()) { result.skippedForCapacity=true; break; }
      if (!state.entries[entry.id] && Object.keys(state.entries).length >= 20000) { result.sessionsFailed++; break; }
      result.sessionsAttempted++;
      const attemptedAt = Date.now();
      try {
        const stats=await ingest(op,{...input,file:entry.file,session:entry.session,collectorLookback:3});
        result.itemsImported+=stats.itemsImported || 0;
        const after=await fs.lstat(entry.file); const sig=signature(after);
        const old=state.entries[entry.id] || {};
        if (sig !== entry.sig) state.entries[entry.id]={...old,partial:true,attemptedAt};
        else if (stats.partial && stats.progressed) state.entries[entry.id]={...old,partial:true,attemptedAt};
        else if (stats.partial) state.entries[entry.id]={...old,partial:true,blocked:sig,attemptedAt};
        else state.entries[entry.id]={sig,attemptedAt};
        await save();
      } catch (error) {
        result.sessionsFailed++;
        const old = state.entries[entry.id] || {};
        state.entries[entry.id] = { ...old, attemptedAt, ...(error.code === 'COLLECTOR_BATCH_LIMIT' ? { blocked: entry.sig } : {}) };
      }
    }
    result.pending=current.filter(e=>{ const old=state.entries[e.id]; return !old || old.sig !== e.sig || old.partial; }).length;
    result.blocked=current.filter(e => state.entries[e.id]?.blocked === e.sig).length;
    await save(); return result;
  });
}
module.exports={collectChanged};
