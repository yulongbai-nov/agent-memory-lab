'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {canonical,openStorage} = require('./storage.cjs');
const {withWriterLock} = require('./lock.cjs');
const {bounds, compareBound, reviewedTimeKey} = require('./query-time.cjs');
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
function makeApi(db, writable, incarnation = "migration") {
  db.function('memory_time_compare', {deterministic:true}, (value,bound) => compareBound(value,bound));
  db.function('memory_reviewed_time_key', {deterministic:true}, reviewedTimeKey);
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
      const narrowedReview = Boolean(filters.reviewOnly && filters.topic && !filters.taskOnly);
      if (filters.topic && !narrowedReview) {
        clauses.push("(v.topic=? OR EXISTS (SELECT 1 FROM annotations a WHERE a.owner=v.owner AND a.project=v.project AND a.topic=? AND a.kind IN ('decision','change','todo') AND a.target_id=v.item_id AND a.target_revision=v.version_id))");
        args.push(filters.topic,filters.topic);
      }
      const legacyReview = `((json_type(v.data,'$.item.metadata.reviewed') NOT IN ('null','false') AND json_type(v.data,'$.item.metadata.reviewed') IS NOT NULL AND json_extract(v.data,'$.item.metadata.reviewed') NOT IN (0,'')) AND json_extract(v.data,'$.item.metadata.kind') IN (${filters.reviewedTimeline ? "'decision','change','todo'" : "'decision','change'"}))`;
      if (filters.reviewOnly && !narrowedReview) clauses.push(`(${legacyReview} OR EXISTS (SELECT 1 FROM annotations a WHERE a.owner=v.owner AND a.project=v.project AND a.kind IN ('decision','change','todo') AND a.target_id=v.item_id AND a.target_revision=v.version_id))`);
      if (filters.taskOnly) {
        const legacyTask = "(json_type(v.data,'$.item.metadata.reviewed')='true' AND json_extract(v.data,'$.item.metadata.kind')='todo')";
        return stmt(`WITH task_versions AS (
          SELECT v.seq FROM versions v WHERE v.owner=? AND v.project=? AND ${legacyTask}
          UNION
          SELECT v.seq FROM annotations a JOIN versions v ON v.version_id=a.target_revision
            AND v.owner=a.owner AND v.project=a.project AND v.item_id=a.target_id
          WHERE a.owner=? AND a.project=? AND a.kind='todo'
        )
        SELECT CASE WHEN ${legacyTask} THEN v.data ELSE json_object(
          'versionId',v.version_id,'scope',json_object('owner',v.owner,'project',v.project),
          'source',json_extract(v.data,'$.source'),'item',json_object('id',v.item_id)
        ) END AS data FROM task_versions t JOIN versions v ON v.seq=t.seq
        WHERE ${clauses.join(' AND ')} ORDER BY v.seq`).all(scope.owner,scope.project,scope.owner,scope.project,...args).map(parse);
      }
      // Enumerate review targets first. Native legacy reviews use the topic index;
      // annotations use their scoped topic index or scoped target references. The
      // unique version ID lookup is checked against both scope and item ID.
      // UNION removes versions with multiple reviews or matching both routes.
      const candidates = narrowedReview ? `WITH review_candidates AS MATERIALIZED (
        SELECT v.seq FROM versions v INDEXED BY version_scope_topic
          WHERE v.owner=? AND v.project=? AND v.topic=? AND ${legacyReview}
        UNION
        SELECT v.seq FROM annotations a INDEXED BY annotation_topic_target
          JOIN versions v ON v.version_id=a.target_revision AND v.owner=a.owner
            AND v.project=a.project AND v.item_id=a.target_id
          WHERE a.owner=? AND a.project=? AND a.topic=? AND a.kind IN ('decision','change','todo')
        UNION
        SELECT v.seq FROM annotations a INDEXED BY annotation_scope
          JOIN versions v ON v.version_id=a.target_revision AND v.owner=a.owner
            AND v.project=a.project AND v.item_id=a.target_id
          WHERE a.owner=? AND a.project=? AND v.topic=? AND a.kind IN ('decision','change','todo')
      ) ` : '';
      const candidateArgs = narrowedReview ? [scope.owner,scope.project,filters.topic,scope.owner,scope.project,filters.topic,scope.owner,scope.project,filters.topic] : [];
      const versionFrom = narrowedReview ? 'review_candidates c CROSS JOIN versions v ON v.seq=c.seq' : 'versions v';
      if (filters.reviewedTimeline || (filters.reviewOnly && filters.compactReviewTargets && !q)) {
        return stmt(`${candidates}SELECT CASE WHEN ${legacyReview} THEN v.data ELSE json_object('versionId',v.version_id,'scope',json_object('owner',v.owner,'project',v.project),'source',json_extract(v.data,'$.source'),'item',json_object('id',v.item_id,'time',v.stamp,'metadata',json_object('topic',v.topic))) END AS data FROM ${versionFrom} WHERE ${clauses.join(' AND ')} ORDER BY v.seq`).all(...candidateArgs,...args).map(parse);
      }
      if (filters.summaries && !q) {
        return stmt(`${candidates}SELECT v.version_id, v.item_id, json_extract(v.data,'$.item.title') AS title, json_extract(v.data,'$.item.timestamp') AS timestamp, json_extract(v.data,'$.item.time') AS time, json_extract(v.data,'$.item.valid_time') AS valid_time, json_extract(v.data,'$.item.created_at') AS created_at, json_extract(v.data,'$.item.metadata.topic') AS topic, json_type(v.data,'$.item.metadata.topic') AS topic_type, json_extract(v.data,'$.source.harness') AS harness, json_extract(v.data,'$.source.instance') AS instance, json_extract(v.data,'$.source.session') AS session FROM ${versionFrom} WHERE ${clauses.join(' AND ')} ORDER BY v.seq`).all(...candidateArgs,...args).map(row => {
          const item={id:row.item_id,metadata:{}};
          for (const key of ['title','timestamp','time','valid_time','created_at']) if (row[key] !== null) item[key]=row[key];
          if (row.topic_type && row.topic_type !== 'null') item.metadata.topic = ['object','array'].includes(row.topic_type) ? JSON.parse(row.topic) : row.topic;
          return {versionId:row.version_id,scope:{owner:scope.owner,project:scope.project},source:{harness:row.harness,instance:row.instance,session:row.session},item};
        });
      }
      return stmt(`${candidates}SELECT v.data FROM ${versionFrom} WHERE ${clauses.join(' AND ')} ORDER BY v.seq`).all(...candidateArgs,...args).map(parse);
    },
    reviewedHistoryPage(scope, filters, position, limit) {
      // LIMIT applies to review rows, not source versions: several reviews may
      // share one target. Dependencies remain complete for each selected root.
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid reviewed timeline limit');
      const range=bounds(filters), args=[scope.owner,scope.project,filters.topic];
      const date=[];
      if (range.from !== null) { date.push('memory_time_compare(v.stamp,?)>=0'); args.push(range.from); }
      if (range.to !== null) { date.push(`memory_time_compare(v.stamp,?)${range.exclusive ? '<' : '<='}0`); args.push(range.to); }
      const dates=date.length ? ' AND '+date.join(' AND ') : '';
      const annotated=`SELECT COALESCE(NULLIF(json_extract(a.data,'$.valid_time'),''),v.stamp),1,'',
          a.rowid,v.seq,a.rowid,v.item_id,v.version_id,json_extract(a.data,'$.id'),a.kind
        FROM annotations a`;
      const exactTarget=`JOIN versions v ON v.version_id=a.target_revision AND v.owner=a.owner
          AND v.project=a.project AND v.item_id=a.target_id
        WHERE a.owner=? AND a.project=? AND a.kind IN ('decision','change','todo')`;
      const roots=`WITH roots AS MATERIALIZED (
        SELECT v.stamp AS event_time,0 AS kind,v.item_id AS item_id,
          v.seq AS row_seq,v.seq AS version_seq,NULL AS annotation_seq,v.item_id AS target_id,v.version_id AS target_revision,
          NULL AS review_id,json_extract(v.data,'$.item.metadata.kind') AS review_kind
        FROM versions v WHERE v.owner=? AND v.project=? AND v.topic=?${dates}
          AND json_type(v.data,'$.item.metadata.reviewed') NOT IN ('null','false')
          AND json_type(v.data,'$.item.metadata.reviewed') IS NOT NULL
          AND json_extract(v.data,'$.item.metadata.reviewed') NOT IN (0,'')
          AND json_extract(v.data,'$.item.metadata.kind') IN ('decision','change','todo')
        UNION ALL
        ${annotated} INDEXED BY annotation_topic_target ${exactTarget} AND a.topic=?${dates}
        UNION ALL
        ${annotated} INDEXED BY annotation_scope ${exactTarget} AND v.topic=?${dates}
          AND (a.topic IS NULL OR a.topic='')
      ) `;
      const rootArgs=[...args,...args,...args];
      const orderKey='memory_reviewed_time_key(event_time),kind,item_id COLLATE BINARY,row_seq';
      // All relevant dependencies, including those attached to roots on later
      // pages, participate in the cursor generation. Other notes do not.
      const dependency=`a.owner=? AND a.project=? AND EXISTS (SELECT 1 FROM roots r
        WHERE a.target_id=r.target_id AND a.target_revision=r.target_revision AND (
          (r.kind=0 AND a.kind='annotation') OR
          (r.kind=1 AND a.kind='correction' AND json_extract(a.data,'$.revises')=r.review_id) OR
          (r.review_kind='todo' AND a.kind='task-state' AND (
            (r.kind=1 AND json_extract(a.data,'$.taskRoot.kind')='annotation' AND json_extract(a.data,'$.taskRoot.id')=r.review_id) OR
            (r.kind=0 AND json_extract(a.data,'$.taskRoot.kind')='source' AND json_extract(a.data,'$.taskRoot.id')=r.target_id AND json_extract(a.data,'$.taskRoot.revision')=r.target_revision)
          ))))`;
      const ownTransaction=!db.isTransaction;
      if (ownTransaction) db.exec('BEGIN');
      try {
        const generation=stmt(`${roots}, deps AS (
          SELECT count(*) AS n, COALESCE(max(a.rowid),0) AS latest FROM annotations a WHERE ${dependency}
        ) SELECT
          (SELECT count(*) FROM roots) AS roots_count,
          (SELECT COALESCE(max(version_seq),0) FROM roots) AS version_max,
          (SELECT COALESCE(max(annotation_seq),0) FROM roots) AS annotation_max,
          deps.n AS deps_count,deps.latest AS deps_max FROM deps`)
          .get(...rootArgs,scope.owner,scope.project);
        const snapshot=crypto.createHash('sha256').update(json([incarnation,generation])).digest('hex');
        if (position && position.snapshot !== snapshot) throw new Error('reviewed timeline cursor is stale');
        if (position && (!Array.isArray(position.after) || position.after.length!==4)) throw new Error('invalid reviewed timeline cursor');
        if (position && !stmt(`${roots} SELECT 1 AS found FROM roots WHERE kind=? AND item_id COLLATE BINARY=? AND row_seq=? AND memory_reviewed_time_key(event_time)=?`)
          .get(...rootArgs,...position.after.slice(1),position.after[0])) throw new Error('invalid reviewed timeline cursor');
        const where=position ? `WHERE (${orderKey})>(?,?,?,?)` : '';
        const keys=stmt(`${roots} SELECT *,memory_reviewed_time_key(event_time) AS time_key FROM roots ${where} ORDER BY time_key,kind,item_id COLLATE BINARY,row_seq LIMIT ?`)
          .all(...rootArgs,...(position ? position.after : []),limit+1);
        const selected=keys.slice(0,limit);
        const chosen=json(selected);
        const entries=stmt(`SELECT CASE WHEN json_extract(s.value,'$.kind')=0 THEN v.data ELSE json_object(
          'versionId',v.version_id,'scope',json_object('owner',v.owner,'project',v.project),
          'source',json_extract(v.data,'$.source'),
          'item',json_object('id',v.item_id,'time',v.stamp,'metadata',json_object('topic',v.topic))
        ) END AS record, a.data AS annotation
        FROM json_each(?) s JOIN versions v ON v.seq=json_extract(s.value,'$.version_seq')
        LEFT JOIN annotations a ON a.rowid=json_extract(s.value,'$.annotation_seq')
        ORDER BY CAST(s.key AS INTEGER)`).all(chosen).map(row=>({
          record:JSON.parse(row.record),
          annotation:row.annotation===null ? null : JSON.parse(row.annotation),
        }));
        const selectedRoots=`WITH roots AS MATERIALIZED (SELECT json_extract(value,'$.kind') AS kind,
          json_extract(value,'$.target_id') AS target_id,json_extract(value,'$.target_revision') AS target_revision,
          json_extract(value,'$.review_id') AS review_id,json_extract(value,'$.review_kind') AS review_kind FROM json_each(?)) `;
        const dependencies=stmt(`${selectedRoots} SELECT a.data FROM annotations a WHERE ${dependency} ORDER BY a.rowid`)
          .all(chosen,scope.owner,scope.project).map(parse);
        const last=selected.at(-1);
        const next=keys.length>limit && last ? {after:[last.time_key,last.kind,last.item_id,last.row_seq],snapshot} : null;
        if (ownTransaction) db.exec('COMMIT');
        return {entries,dependencies,next};
      } catch (error) { if (ownTransaction) db.exec('ROLLBACK'); throw error; }
    },
    originalCoverageInputs(scope, source, first, last) {
      const {MAX_ORIGINAL_COVERAGE_VARIANTS,validateOriginalCoverageWindow}=require('./generated/original-coverage.cjs');
      validateOriginalCoverageWindow(first,last);
      const identity=json([scope.owner,scope.project,source.harness,source.instance,source.session]);
      const sourceWhere=`owner=? AND project=? AND json_extract(data,'$.source.harness')=?
        AND json_extract(data,'$.source.instance')=? AND json_extract(data,'$.source.session')=?`;
      const sourceArgs=[scope.owner,scope.project,source.harness,source.instance,source.session];
      const ownTransaction=!db.isTransaction;
      if (ownTransaction) db.exec('BEGIN');
      try {
        const checkpoint=parse(stmt('SELECT data FROM checkpoints WHERE identity=? AND owner=? AND project=?').get(identity,scope.owner,scope.project));
        if (checkpoint && (!Number.isSafeInteger(checkpoint.position) || checkpoint.position<0))
          throw new Error('Invalid source checkpoint position');
        const fence=stmt(`SELECT COALESCE(max(seq),0) AS n FROM versions WHERE ${sourceWhere}`).get(...sourceArgs).n;
        const snapshot=crypto.createHash('sha256').update(canonical([incarnation,scope,source,checkpoint,fence])).digest('hex');
        const rows=checkpoint ? stmt(`SELECT item_id, json_extract(data,'$.item.metadata.coordinate') AS coordinate,
          json_type(data,'$.item.metadata.original') AS original_type,
          json_extract(data,'$.item.metadata.original') AS original_value
          FROM versions WHERE ${sourceWhere} AND seq<=?
            AND json_type(data,'$.item.metadata.coordinate')='integer'
            AND json_extract(data,'$.item.metadata.coordinate') BETWEEN ? AND ?
          ORDER BY seq LIMIT ?`).all(...sourceArgs,fence,first,Math.min(last,checkpoint.position),MAX_ORIGINAL_COVERAGE_VARIANTS+1) : [];
        if (rows.length>MAX_ORIGINAL_COVERAGE_VARIANTS) throw new Error('Original coverage input limit exceeded');
        const inputs=rows.map(row=>({coordinate:row.coordinate,itemId:row.item_id,
          original:row.original_type==='true' ? true : row.original_type==='false' ? false :
            ['object','array'].includes(row.original_type) ? JSON.parse(row.original_value) : row.original_value}));
        if (ownTransaction) db.exec('COMMIT');
        return {checkpoint,snapshot,inputs};
      } catch (error) { if (ownTransaction) db.exec('ROLLBACK'); throw error; }
    },
    topicSources(scope, filters, cursor, limit) {
      const range=bounds(filters), fence=cursor?.fence ?? stmt('SELECT COALESCE(max(seq),0) AS n FROM versions').get().n;
      const clauses=['owner=?','project=?','topic=?','seq>?','seq<=?'], args=[scope.owner,scope.project,filters.topic,cursor?.after ?? 0,fence];
      if (range.from !== null) { clauses.push('memory_time_compare(stamp,?)>=0'); args.push(range.from); }
      if (range.to !== null) { clauses.push(`memory_time_compare(stamp,?)${range.exclusive ? '<' : '<='}0`); args.push(range.to); }
      const rows=stmt(`SELECT seq,version_id,item_id,stamp,topic,
        json_extract(data,'$.source.harness') AS harness,json_extract(data,'$.source.instance') AS instance,
        json_extract(data,'$.source.session') AS session FROM versions INDEXED BY version_scope_topic
        WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args,limit+1);
      const more=rows.length>limit, page=rows.slice(0,limit);
      return {records:page.map(r=>({versionId:r.version_id,scope,source:{harness:r.harness,instance:r.instance,session:r.session},item:{id:r.item_id,time:r.stamp,metadata:{topic:r.topic}}})),
        next:more?{after:page.at(-1).seq,fence}:null};
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
        json_extract(scoped,'$.item.metadata.recordType') AS record_type,
        json_extract(scoped,'$.item.metadata.adapterVersion') AS adapter_version,
        json_extract(scoped,'$.item.revision') AS native_revision,
        json_extract(scoped,'$.item.metadata.coordinate') AS coordinate,
        json_extract(scoped,'$.item.metadata.original') AS original
        FROM page ORDER BY seq`)
        .all(scope.owner,scope.project,scope.owner,scope.project,after,fence,limit)
        .map(row=>({seq:row.seq,record:row.version_id===null?null:{versionId:row.version_id,
          source:{harness:row.harness,instance:row.instance,session:row.session},
          item:{id:row.item_id,turnId:row.turn_id,kind:row.kind,role:row.role,status:row.status,metadata:{recordType:row.record_type,adapterVersion:row.adapter_version,nativeRevision:row.native_revision,coordinate:row.coordinate,original:typeof row.original==='string'?JSON.parse(row.original):null}}}}));
    },
    findItems(scope,id,revision) { return (revision === undefined ? stmt('SELECT data FROM versions WHERE owner=? AND project=? AND item_id=? ORDER BY seq').all(scope.owner,scope.project,id) : stmt('SELECT data FROM versions WHERE owner=? AND project=? AND item_id=? AND version_id=? ORDER BY seq').all(scope.owner,scope.project,id,revision)).map(parse); },
    findDraftEvidence(scope,source,id,revision,identity) {
      const row = stmt(`SELECT
        CASE WHEN json_type(v.data,'$.item.text')='text' AND length(CAST(json_extract(v.data,'$.item.text') AS BLOB))<=1048576
          THEN json_extract(v.data,'$.item.text') END AS preview,
        CASE WHEN json_extract(v.data,'$.item.role') IN ('user','assistant') THEN json_extract(v.data,'$.item.role') END AS role,
        json_type(v.data,'$.item.metadata.recordType') AS record_type_type,
        json_extract(v.data,'$.item.metadata.recordType') AS record_type,
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
      return {row:{source,item:{kind:'message',text:row.preview,role:row.role,metadata:{original,...(row.record_type_type===null?{}:{recordType:row.record_type})}}},currentRevision:row.current_revision};
    },
    listSources(scope) { return stmt('SELECT data FROM checkpoints WHERE owner=? AND project=? ORDER BY rowid').all(scope.owner,scope.project).map(parse); },
    listAnnotations(scope, target) { return (target ? stmt("SELECT data FROM annotations WHERE owner=? AND project=? AND target_id=? AND target_revision=? ORDER BY rowid").all(scope.owner,scope.project,target.id,target.revision) : stmt('SELECT data FROM annotations WHERE owner=? AND project=? ORDER BY rowid').all(scope.owner,scope.project)).map(parse); },
    listAnnotationsForTargets(scope, targets) {
      if (!targets.length) return [];
      return stmt(`SELECT data FROM annotations WHERE owner=? AND project=?
        AND (target_id,target_revision) IN (
          SELECT json_extract(value,'$.id'),json_extract(value,'$.revision') FROM json_each(?)
        ) ORDER BY rowid`).all(scope.owner,scope.project,JSON.stringify(targets)).map(parse);
    },
    findVersion(scope,id,revision) { return parse(stmt('SELECT data FROM versions WHERE owner=? AND project=? AND item_id=? AND version_id=?').get(scope.owner,scope.project,id,revision)); }
  };
}
async function checkedFile(file) {
  const st=await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error('SQLite archive must be private and not a symlink');
  return st;
}
async function openSqlite({dir,readOnly=false}) {
  // Reuse directory privacy/worktree validation without reading JSON.
  const storage=await openStorage({dir,readOnly:true}); dir=storage.dir;
  const file=path.join(dir,'archive.sqlite3'), fileStat=await checkedFile(file);
  const db=new DatabaseSync(file,{readOnly,timeout:3000});
  let writing=false;
  try { if (db.prepare("SELECT value FROM meta WHERE key='format'").get()?.value !== '2') throw new Error('Unsupported SQLite archive format'); }
  catch(e) { db.close(); throw e; }
  const incarnation=json([fileStat.dev,fileStat.ino,fileStat.birthtimeMs]);
  const api=makeApi(db,()=>writing,incarnation);
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
