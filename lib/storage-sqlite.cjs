'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {canonical,openStorage} = require('./storage.cjs');
const {withWriterLock} = require('./lock.cjs');
const {bounds, compareBound} = require('./query-time.cjs');
const json = value => JSON.stringify(value);
const parse = row => row ? JSON.parse(row.data) : null;
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('format', '2');
CREATE TABLE batches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE checkpoints (identity TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX checkpoint_scope ON checkpoints(owner,project);
CREATE TABLE versions (seq INTEGER PRIMARY KEY, version_id TEXT NOT NULL UNIQUE, identity TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, item_id TEXT NOT NULL, stamp TEXT NOT NULL, topic TEXT NOT NULL, search_fields TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX version_scope_item ON versions(owner,project,item_id,seq);
CREATE INDEX version_scope_time ON versions(owner,project,stamp);
CREATE INDEX version_scope_topic ON versions(owner,project,topic);
CREATE TABLE annotations (identity TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, topic TEXT, kind TEXT NOT NULL, target_id TEXT, target_revision TEXT, data TEXT NOT NULL);
CREATE INDEX annotation_scope ON annotations(owner,project);
CREATE INDEX annotation_topic_target ON annotations(owner,project,topic,target_id,target_revision);
`;
function projected(record) {
  const item=record.item, meta=item.metadata || {};
  const stamp=item.timestamp || item.time || item.valid_time || item.created_at || '';
  const topic=String(meta.topic || (record.source ? [record.source.harness,record.source.instance,record.source.session].join(' / ') : item.title || item.id));
  return {stamp:String(stamp),topic,search:json([item.title,item.text,meta.topic,meta.next_step].filter(x=>typeof x === 'string'))};
}
function makeApi(db, writable) {
  db.function('memory_time_compare', {deterministic:true}, (value,bound) => compareBound(value,bound));
  db.function('memory_keyword', {deterministic:true}, (fields,query) => JSON.parse(fields).some(value=>value.toLocaleLowerCase().includes(query)) ? 1 : 0);
  const statements = new Map();
  const stmt = sql => {if (!statements.has(sql)) statements.set(sql,db.prepare(sql)); return statements.get(sql);};
  const write = () => { if (!writable()) throw new Error('Writes require a transaction'); };
  const insertImmutable = (table,column,id,value) => {
    write(); const old=stmt(`SELECT data FROM ${table} WHERE ${column}=?`).get(id);
    if (old) { if (canonical(JSON.parse(old.data)) !== canonical(value)) throw new Error('Immutable record conflict'); return false; }
    return true;
  };
  return {
    getBatch(id) { return parse(stmt('SELECT data FROM batches WHERE id=?').get(id)); },
    putBatch(id,position) { const data={position}; if (insertImmutable('batches','id',id,data)) stmt('INSERT INTO batches VALUES (?,?)').run(id,json(data)); },
    getCheckpoint(id) { return parse(stmt('SELECT data FROM checkpoints WHERE identity=?').get(id)); },
    putCheckpoint(id,record) { write(); stmt('INSERT INTO checkpoints VALUES (?,?,?,?) ON CONFLICT(identity) DO UPDATE SET owner=excluded.owner,project=excluded.project,data=excluded.data').run(id,record.scope.owner,record.scope.project,json(record)); },
    hasVersion(id) { return Boolean(stmt('SELECT 1 FROM versions WHERE version_id=?').get(id)); },
    putVersion(id,record) { if (insertImmutable('versions','version_id',record.versionId,record)) { const p=projected(record); stmt('INSERT INTO versions(version_id,identity,owner,project,item_id,stamp,topic,search_fields,data) VALUES (?,?,?,?,?,?,?,?,?)').run(record.versionId,id,record.scope.owner,record.scope.project,record.item.id,p.stamp,p.topic,p.search,json(record)); } },
    getAnnotation(id) { return parse(stmt('SELECT data FROM annotations WHERE identity=?').get(id)); },
    putAnnotation(id,record) { if (insertImmutable('annotations','identity',id,record)) stmt('INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?)').run(id,record.scope.owner,record.scope.project,record.topic || null,record.kind,record.target?.id || null,record.target?.revision || null,json(record)); },
    listItems(scope, filters={}) {
      const clauses=['v.owner=?','v.project=?'], args=[scope.owner,scope.project];
      const range=bounds(filters);
      if (range.from !== null) { clauses.push("memory_time_compare(v.stamp,?)>=0"); args.push(range.from); }
      if (range.to !== null) { clauses.push(`memory_time_compare(v.stamp,?)${range.exclusive ? "<" : "<="}0`); args.push(range.to); }
      const q=String(filters.keyword || '').toLocaleLowerCase().trim();
      if (q) { clauses.push('memory_keyword(v.search_fields,?)=1'); args.push(q); }
      if (filters.topic) {
        clauses.push("(v.topic=? OR EXISTS (SELECT 1 FROM annotations a WHERE a.owner=v.owner AND a.project=v.project AND a.topic=? AND a.kind IN ('decision','change','todo') AND a.target_id=v.item_id AND a.target_revision=v.version_id))");
        args.push(filters.topic,filters.topic);
      }
      if (filters.reviewOnly) clauses.push(`((json_type(v.data,'$.item.metadata.reviewed') NOT IN ('null','false') AND json_type(v.data,'$.item.metadata.reviewed') IS NOT NULL AND json_extract(v.data,'$.item.metadata.reviewed') NOT IN (0,'')) AND json_extract(v.data,'$.item.metadata.kind') IN ('decision','change') OR EXISTS (SELECT 1 FROM annotations a WHERE a.owner=v.owner AND a.project=v.project AND a.kind IN ('decision','change','todo') AND a.target_id=v.item_id AND a.target_revision=v.version_id))`);
      if (filters.summaries && !q) {
        return stmt(`SELECT v.version_id, v.item_id, json_extract(v.data,'$.item.title') AS title, json_extract(v.data,'$.item.timestamp') AS timestamp, json_extract(v.data,'$.item.time') AS time, json_extract(v.data,'$.item.valid_time') AS valid_time, json_extract(v.data,'$.item.created_at') AS created_at, json_extract(v.data,'$.item.metadata.topic') AS topic, json_type(v.data,'$.item.metadata.topic') AS topic_type, json_extract(v.data,'$.source.harness') AS harness, json_extract(v.data,'$.source.instance') AS instance, json_extract(v.data,'$.source.session') AS session FROM versions v WHERE ${clauses.join(' AND ')} ORDER BY v.seq`).all(...args).map(row => {
          const item={id:row.item_id,metadata:{}};
          for (const key of ['title','timestamp','time','valid_time','created_at']) if (row[key] !== null) item[key]=row[key];
          if (row.topic_type && row.topic_type !== 'null') item.metadata.topic = ['object','array'].includes(row.topic_type) ? JSON.parse(row.topic) : row.topic;
          return {versionId:row.version_id,scope:{owner:scope.owner,project:scope.project},source:{harness:row.harness,instance:row.instance,session:row.session},item};
        });
      }
      return stmt(`SELECT v.data FROM versions v WHERE ${clauses.join(' AND ')} ORDER BY v.seq`).all(...args).map(parse);
    },
    listVersionSummaries(scope) {
      return stmt(`SELECT version_id, CASE WHEN json_extract(data,'$.item.role')='user' AND json_type(data,'$.item.text')='text' AND json_extract(data,'$.item.text')<>'' AND (json_type(data,'$.item.metadata.reviewed') IS NULL OR json_type(data,'$.item.metadata.reviewed') IN ('null','false') OR json_extract(data,'$.item.metadata.reviewed') IN (0,'')) THEN 1 ELSE 0 END AS pending, CASE WHEN json_type(data,'$.item.text')='text' THEN length(CAST(json_extract(data,'$.item.text') AS BLOB)) ELSE 0 END AS bytes FROM versions WHERE owner=? AND project=? ORDER BY seq`).all(scope.owner,scope.project).map(row=>({versionId:row.version_id,pendingReview:Boolean(row.pending),previewBytes:row.pending ? row.bytes : 0}));
    },
    localDeriveMessages(scope) {
      // Inspect a bounded window of turn markers and complete message previews.
      // Do not materialize raw originals, tool results, or entire sessions.
      return stmt(`
        WITH recent AS MATERIALIZED (
          SELECT seq, data, item_id, stamp,
            json_extract(data,'$.source.harness') AS harness,
            json_extract(data,'$.source.instance') AS instance,
            json_extract(data,'$.source.session') AS session,
            json_extract(data,'$.item.turnId') AS turn_id,
            json_extract(data,'$.item.metadata.recordType') AS record_type,
            json_extract(data,'$.item.status') AS item_status,
            json_extract(data,'$.item.role') AS role
          FROM versions
          WHERE owner=? AND project=?
            AND json_extract(data,'$.source.harness') IN ('dsh','codex')
            AND json_extract(data,'$.item.turnId') IS NOT NULL
            AND ((json_extract(data,'$.item.status') IN ('completed','failed','interrupted')
                 AND (json_extract(data,'$.item.metadata.recordType') GLOB 'turn/end*'
                      OR json_extract(data,'$.item.metadata.recordType') IN
                         ('event_msg:task_complete','event_msg:turn_completed','turn/completed')))
                 OR (json_extract(data,'$.item.kind')='message'
                 AND json_extract(data,'$.item.role') IN ('user','assistant')
                 AND length(CAST(json_extract(data,'$.item.text') AS BLOB)) BETWEEN 8 AND 32768))
          ORDER BY stamp DESC,seq DESC LIMIT 1500
        ), eligible AS (
        SELECT message.* FROM recent message
        WHERE message.role IN ('user','assistant')
          AND json_extract(message.data,'$.item.kind')='message'
          AND length(CAST(json_extract(message.data,'$.item.text') AS BLOB)) BETWEEN 8 AND 32768
          AND (message.record_type IN ('user/message','assistant/message','response_item:message')
            OR message.record_type GLOB 'user/message:*' OR message.record_type GLOB 'assistant/message:*')
          AND (message.item_status IS NULL OR message.item_status='completed')
          AND json_extract(message.data,'$.item.metadata.original.availability')='archived'
          AND EXISTS (
            SELECT 1 FROM recent terminal
            WHERE terminal.harness=message.harness AND terminal.instance=message.instance
              AND terminal.session=message.session AND terminal.turn_id=message.turn_id
              AND terminal.item_status='completed'
              AND (terminal.record_type='turn/end' OR terminal.record_type GLOB 'turn/end:*'
                   OR terminal.record_type IN ('event_msg:task_complete','event_msg:turn_completed','turn/completed'))
          )
          AND NOT EXISTS (
            SELECT 1 FROM recent invalid
            WHERE invalid.harness=message.harness AND invalid.instance=message.instance
              AND invalid.session=message.session AND invalid.turn_id=message.turn_id
              AND invalid.item_status IN ('failed','interrupted')
          )
        ), picked_turns AS (
          SELECT harness,instance,session,turn_id
          FROM eligible WHERE role='user'
          GROUP BY harness,instance,session,turn_id
          ORDER BY max(stamp) DESC,max(seq) DESC LIMIT 20
        ), ranked AS (
          SELECT message.data, message.stamp, message.seq,
            row_number() OVER (PARTITION BY message.harness,message.instance,message.session,message.turn_id
              ORDER BY (message.role='user') DESC,
                (lower(json_extract(message.data,'$.item.text')) GLOB '*decid*' OR lower(json_extract(message.data,'$.item.text')) GLOB '*next*' OR lower(json_extract(message.data,'$.item.text')) GLOB '*chang*' OR lower(json_extract(message.data,'$.item.text')) GLOB '*todo*' OR json_extract(message.data,'$.item.text') GLOB '*决定*' OR json_extract(message.data,'$.item.text') GLOB '*下一步*') DESC,
                message.stamp DESC,message.seq DESC) AS item_rank
          FROM eligible message JOIN picked_turns turn
            ON turn.harness=message.harness AND turn.instance=message.instance
              AND turn.session=message.session AND turn.turn_id=message.turn_id
        )
        SELECT data FROM ranked WHERE item_rank <= 12 ORDER BY stamp DESC,seq DESC
      `).all(scope.owner,scope.project).map(parse);
    },
    localDraftFence() {
      return stmt('SELECT COALESCE(max(seq),0) AS seq FROM versions').get().seq;
    },
    localDraftAnchor(seq) {
      if (seq===0) return null;
      const row=stmt("SELECT version_id FROM versions WHERE seq=?").get(seq);
      return row ? crypto.createHash("sha256").update(JSON.stringify([seq,row.version_id])).digest("hex") : null;
    },
    localDraftPage(scope,after,fence,limit) {
      // Bound the global sequence scan, and never return another scope's body
      // or any message text. The indexer only needs source and turn metadata.
      return stmt(`WITH page AS MATERIALIZED (
        SELECT seq, CASE WHEN owner=? AND project=? THEN data ELSE NULL END AS scoped,
          CASE WHEN owner=? AND project=? THEN version_id ELSE NULL END AS version_id
        FROM versions WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?
      ) SELECT seq,version_id,
        json_extract(scoped,'$.source.harness') AS harness,
        json_extract(scoped,'$.source.instance') AS instance,
        json_extract(scoped,'$.source.session') AS session,
        json_extract(scoped,'$.item.id') AS item_id,
        json_extract(scoped,'$.item.turnId') AS turn_id,
        json_extract(scoped,'$.item.kind') AS kind,
        json_extract(scoped,'$.item.role') AS role,
        json_extract(scoped,'$.item.status') AS status,
        json_extract(scoped,'$.item.metadata.recordType') AS record_type
        FROM page ORDER BY seq`)
        .all(scope.owner,scope.project,scope.owner,scope.project,after,fence,limit)
        .map(row=>({seq:row.seq,record:row.version_id===null?null:{versionId:row.version_id,
          source:{harness:row.harness,instance:row.instance,session:row.session},
          item:{id:row.item_id,turnId:row.turn_id,kind:row.kind,role:row.role,status:row.status,metadata:{recordType:row.record_type}}}}));
    },
    findItems(scope,id,revision) { return (revision === undefined ? stmt('SELECT data FROM versions WHERE owner=? AND project=? AND item_id=? ORDER BY seq').all(scope.owner,scope.project,id) : stmt('SELECT data FROM versions WHERE owner=? AND project=? AND item_id=? AND version_id=? ORDER BY seq').all(scope.owner,scope.project,id,revision)).map(parse); },
    findDraftEvidence(scope,source,id,revision,identity) {
      const row = stmt(`SELECT
        CASE WHEN json_type(v.data,'$.item.text')='text' AND length(CAST(json_extract(v.data,'$.item.text') AS BLOB))<=1048576
          THEN json_extract(v.data,'$.item.text') END AS preview,
        CASE WHEN json_extract(v.data,'$.item.role') IN ('user','assistant') THEN json_extract(v.data,'$.item.role') END AS role,
        CASE WHEN COALESCE(json_type(v.data,'$.item.metadata.original'),'null')='null' THEN 'source-only'
          WHEN json_type(v.data,'$.item.metadata.original')='object'
            AND json_extract(v.data,'$.item.metadata.original.availability') IN ('source-only','archived')
          THEN json_extract(v.data,'$.item.metadata.original.availability') ELSE 'invalid' END AS original_status,
        CASE WHEN length(json_extract(v.data,'$.item.metadata.original.sha256'))=64 THEN json_extract(v.data,'$.item.metadata.original.sha256') END AS sha256,
        CASE WHEN json_type(v.data,'$.item.metadata.original.bytes')='integer' THEN json_extract(v.data,'$.item.metadata.original.bytes') END AS bytes,
        (SELECT newer.version_id FROM versions newer
          WHERE newer.owner=v.owner AND newer.project=v.project AND newer.item_id=v.item_id AND newer.identity=v.identity
          ORDER BY newer.seq DESC LIMIT 1) AS current_revision
        FROM versions v WHERE v.owner=? AND v.project=? AND v.item_id=? AND v.version_id=? AND v.identity=?
          AND json_extract(v.data,'$.item.kind')='message' AND json_extract(v.data,'$.item.role') IN ('user','assistant')`)
        .get(scope.owner,scope.project,id,revision,identity);
      if (!row) return null;
      const original = {availability:row.original_status,sha256:row.sha256,bytes:row.bytes};
      return {row:{source,item:{text:row.preview,role:row.role,metadata:{original}}},currentRevision:row.current_revision};
    },
    listSources(scope) { return stmt('SELECT data FROM checkpoints WHERE owner=? AND project=? ORDER BY rowid').all(scope.owner,scope.project).map(parse); },
    listAnnotations(scope) { return stmt('SELECT data FROM annotations WHERE owner=? AND project=? ORDER BY rowid').all(scope.owner,scope.project).map(parse); },
    findVersion(scope,id,revision) { return parse(stmt('SELECT data FROM versions WHERE owner=? AND project=? AND item_id=? AND version_id=?').get(scope.owner,scope.project,id,revision)); }
  };
}
async function checkedFile(file) {
  const st=await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error('SQLite archive must be private and not a symlink');
}
async function openSqlite({dir,readOnly=false}) {
  // Reuse directory privacy/worktree validation without reading JSON.
  const storage=await openStorage({dir,readOnly:true}); dir=storage.dir;
  const file=path.join(dir,'archive.sqlite3'); await checkedFile(file);
  const db=new DatabaseSync(file,{readOnly,timeout:3000});
  let writing=false;
  try { if (db.prepare("SELECT value FROM meta WHERE key='format'").get()?.value !== '2') throw new Error('Unsupported SQLite archive format'); }
  catch(e) { db.close(); throw e; }
  const api=makeApi(db,()=>writing);
  return {...api,dir,close:()=>db.close(),async transaction(fn) {
    if (readOnly) throw new Error('Archive is read-only');
    if (typeof fn !== 'function') throw new Error('Transaction callback required');
    return withWriterLock(dir,'archive',async()=>{
      db.exec('BEGIN IMMEDIATE'); writing=true;
      try { const result=fn(api); if (result && typeof result.then === 'function') throw new Error('Transaction callback must be synchronous'); db.exec('COMMIT'); return result; }
      catch(e) { db.exec('ROLLBACK'); throw e; }
      finally { writing=false; }
    },{legacyLock:'.archive.lock'});
  }};
}
async function migrateJsonToSqlite({dir}) {
  const storage=await openStorage({dir,readOnly:true}); dir=storage.dir;
  const dest=path.join(dir,'archive.sqlite3');
  return withWriterLock(dir,'archive',async()=>{
    try { await fs.lstat(dest); throw new Error('SQLite archive already exists'); } catch(e) { if (e.code !== 'ENOENT') throw e; }
    await checkedFile(path.join(dir,'archive.json'));
    const state=await storage.read();
    if (!state.versions || !state.batches || !state.checkpoints || !state.annotations) throw new Error('Invalid JSON archive');
    const temp=path.join(dir,`.sqlite-migration-${crypto.randomUUID()}.tmp`);
    let db;
    try {
      const fd=await fs.open(temp,'wx',0o600); await fd.close(); db=new DatabaseSync(temp);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;'); db.exec(SCHEMA); db.exec('BEGIN IMMEDIATE');
      const api=makeApi(db,()=>true);
      let versions=0;
      for (const [id,items] of Object.entries(state.versions)) { if (!Array.isArray(items)) throw new Error('Invalid versions'); for (const item of items) { api.putVersion(id,item); versions++; } }
      for (const [id,value] of Object.entries(state.batches)) api.putBatch(id,value.position);
      for (const [id,value] of Object.entries(state.checkpoints)) api.putCheckpoint(id,value);
      for (const [id,value] of Object.entries(state.annotations)) api.putAnnotation(id,value);
      const counts={versions,checkpoints:Object.keys(state.checkpoints).length,batches:Object.keys(state.batches).length,annotations:Object.keys(state.annotations).length};
      for (const [table,count] of Object.entries(counts)) if (db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n !== count) throw new Error('Migration count mismatch');
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity check failed');
      db.exec('COMMIT'); db.close(); db=undefined;
      await fs.link(temp,dest); // Atomic no-overwrite publication.
      return counts;
    } finally { if (db) { try { db.close(); } catch {} } await fs.rm(temp,{force:true}); await fs.rm(temp+'-journal',{force:true}); }
  },{legacyLock:'.archive.lock'});
}
async function exportSqliteToJson({dir}) {
  const storage=await openStorage({dir,readOnly:true}); dir=storage.dir;
  const target=path.join(dir,'archive-export.json');
  return withWriterLock(dir,'archive',async()=>{
    try { await fs.lstat(target); throw new Error('Archive export already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await checkedFile(path.join(dir,'archive.sqlite3'));
    const db=new DatabaseSync(path.join(dir,'archive.sqlite3'),{readOnly:true});
    const temp=path.join(dir,`.archive-export-${crypto.randomUUID()}.tmp`);
    try {
      if (db.prepare("SELECT value FROM meta WHERE key='format'").get()?.value !== '2') throw new Error('Unsupported SQLite archive format');
      db.exec('BEGIN');
      const state={format:1,versions:{},batches:{},checkpoints:{},annotations:{}};
      const counts={versions:0,batches:0,checkpoints:0,annotations:0};
      for (const row of db.prepare('SELECT identity,data FROM versions ORDER BY seq').iterate()) { (state.versions[row.identity] ||= []).push(JSON.parse(row.data)); counts.versions++; }
      for (const [table,column] of [['batches','id'],['checkpoints','identity'],['annotations','identity']]) {
        for (const row of db.prepare(`SELECT ${column} AS id,data FROM ${table} ORDER BY rowid`).iterate()) { state[table][row.id]=JSON.parse(row.data); counts[table]++; }
      }
      for (const [table,count] of Object.entries(counts)) if (db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n !== count) throw new Error('Export count mismatch');
      db.exec('COMMIT');
      const fd=await fs.open(temp,'wx',0o600); try { await fd.writeFile(json(state)); await fd.sync(); } finally { await fd.close(); }
      await fs.link(temp,target);
      return {...counts,file:target};
    } finally { db.close(); await fs.rm(temp,{force:true}); }
  },{legacyLock:'.archive.lock'});
}
module.exports={openSqlite,migrateJsonToSqlite,exportSqliteToJson};
