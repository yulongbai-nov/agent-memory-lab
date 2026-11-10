'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {discover} = require('./discover.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const MAX_FAILURES = 200;

// This state contains only opaque source/session identifiers, never source paths.
async function intakeDirectory(op, input, ingest) {
  if (!input.root || !input.instance || !['codex','dsh'].includes(input.source)) throw new Error('Invalid intake source');
  const limit = input['max-sessions'] === undefined ? 25 : Number(input['max-sessions']);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid intake limit');
  const root = await fs.realpath(input.root);
  const sourceId = hash(JSON.stringify([op.scope.owner,op.scope.project,input.source,input.instance,root]));
  const stateFile = path.join(op.archive.dir, `intake-${sourceId}.json`);
  return require('./lock.cjs').withWriterLock(op.archive.dir, `intake:${sourceId}`, async () => {
    let state = {version:1,cursor:null,failed:[],turn:0};
    try {
      const stat = await fs.lstat(stateFile);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Invalid intake state');
      state = JSON.parse(await fs.readFile(stateFile,'utf8'));
      if (state.version !== 1 || !Array.isArray(state.failed) || state.failed.length > MAX_FAILURES || !Number.isSafeInteger(state.turn)) throw new Error('Invalid intake state');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    async function save() {
      const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
      try {
        const fd = await fs.open(temporary,'wx',0o600);
        try { await fd.writeFile(JSON.stringify(state)); await fd.sync(); } finally { await fd.close(); }
        await fs.rename(temporary,stateFile);
      } finally { await fs.rm(temporary,{force:true}); }
    }
    const snapshot = await discover(root,input.source,{maximum:20000,recent:true});
    const recent = snapshot.files.map(entry => ({...entry,id:hash(entry.session)}));
    const ordered = [...recent].sort((a,b)=>a.id.localeCompare(b.id));
    const available = new Map(recent.map(x=>[x.id,x]));
    const attempted = new Set();
    const result = {discovered:snapshot.discovered,inaccessible:snapshot.inaccessible,traversalLimited:snapshot.traversalLimited,sessionsAttempted:0,sessionsFailed:0,itemsImported:0};
    async function attempt(entry, mode) {
      if (!entry || attempted.has(entry.id)) return false;
      attempted.add(entry.id); result.sessionsAttempted++;
      try {
        const stats = await ingest(op,{...input,file:entry.file,session:entry.session});
        result.itemsImported += stats.itemsImported || 0;
        state.failed = state.failed.filter(id=>id !== entry.id);
      } catch {
        result.sessionsFailed++;
        if (state.failed.includes(entry.id)) state.failed = state.failed.filter(id => id !== entry.id);
        else if (state.failed.length >= MAX_FAILURES) { await save(); throw new Error('Intake retry capacity reached'); }
        state.failed.push(entry.id);
      }
      if (mode === 'backfill') state.cursor = entry.id;
      await save();
      return true;
    }
    // A one-session run rotates through retry, recent and catalog work.
    const phases = limit === 1 ? [['retry','recent','backfill'][state.turn % 3]] : limit === 2 ? (state.turn % 2 === 0 ? ['retry','recent','backfill'] : ['backfill','recent','retry']) : ['retry','recent','backfill'];
    state.turn = (state.turn + 1) % 3;
    for (const phase of phases) {
      if (result.sessionsAttempted >= limit) break;
      if (phase === 'retry') {
        const retry = state.failed.map(id=>available.get(id)).find(Boolean);
        if (retry) await attempt(retry,'retry');
      } else if (phase === 'recent') {
        await attempt(recent.find(x=>!attempted.has(x.id)),'recent');
      } else {
        const start = ordered.findIndex(x=>!state.cursor || x.id > state.cursor);
        const rotated = start < 0 ? ordered : [...ordered.slice(start),...ordered.slice(0,start)];
        for (const entry of rotated) {
          if (result.sessionsAttempted >= limit) break;
          await attempt(entry,'backfill');
        }
      }
    }
    // If a preferred phase had no candidate, use remaining capacity for catalog work.
    if (result.sessionsAttempted < limit && ordered.length) {
      const start = ordered.findIndex(x=>!state.cursor || x.id > state.cursor);
      const rotated = start < 0 ? ordered : [...ordered.slice(start),...ordered.slice(0,start)];
      for (const entry of rotated) { if (result.sessionsAttempted >= limit) break; await attempt(entry,'backfill'); }
    }
    await save();
    return result;
  }, {legacyLock:path.basename(stateFile) + '.lock'});
}
module.exports = {intakeDirectory};
