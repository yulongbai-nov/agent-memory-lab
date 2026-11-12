'use strict';

const { originalAvailability } = require('./originals.cjs');
const { reviewedPage, parseReviewedSqliteCursor, encodeReviewedSqliteCursor } = require('./generated/reviewed-page.cjs');
const {projection,rootKey}=require('./task-state.cjs');
const cleanSource=s=>({harness:s.harness,instance:s.instance,session:s.session});
const sourceRoot=i=>({kind:'source',id:i.id,revision:i.revision,source:cleanSource(i.source)});
const annotationRoot=a=>({kind:'annotation',id:a.id});
const taskView=(root,annotations,cancelled=false)=>projection(root,annotations,cancelled);
const { bounds, matchesTime, compareTime } = require('./query-time.cjs');

function scope(input) {
  if (!input || typeof input.owner !== 'string' || !input.owner.trim() || typeof input.project !== 'string' || !input.project.trim()) throw new Error('owner and project are required');
  return {owner: input.owner, project: input.project};
}
function normalize(record) {
  if (!record.item) return record;
  return {...record.item, scope:record.scope, source:record.source, revision:record.versionId};
}
function meta(item) { return item.metadata || {}; }
function stamp(item) { return item.timestamp || item.time || item.valid_time || item.created_at || ''; }
function topic(item) { return String(meta(item).topic || (item.source ? [item.source.harness,item.source.instance,item.source.session].join(' / ') : item.title || item.id)); }
function citation(item) { return item.evidenceCitation || {id: item.id, revision: item.revision, source: item.source}; }
const targetKey = (id, revision) => JSON.stringify([id, revision]);
const lineage=a=>a.candidateReview?{candidateId:a.candidateReview.snapshotSha256+':'+a.candidateReview.ordinal,candidateSha256:a.candidateReview.candidateSha256}:null;
function decisionRecords(items, annotations) {
  const targets = new Map(items.map(item => [targetKey(item.id, item.revision), item]));
  const reviewed = annotations.filter(a => ['decision', 'change'].includes(a.kind)).flatMap(a => {
    const target = targets.get(targetKey(a.target?.id, a.target?.revision));
    if (!target) return [];
    return [{
      id: a.id,
      revision: a.id,
      text: a.text,
      valid_time: a.valid_time || stamp(target),
      evidenceCitation: a.target,
      candidateLineage:lineage(a),
      metadata: {
        topic: a.topic || topic(target),
        reviewed: true,
        kind: a.kind,
        basis: a.basis || 'confirmed',
        lifecycle: a.lifecycle || 'active',
        revises: typeof a.revises === 'string' ? [a.revises] : []
      }
    }];
  });
  return [...items, ...reviewed].filter(item =>
    meta(item).reviewed && ['decision', 'change'].includes(meta(item).kind));
}
function decisionBoundaries(records, annotations) {
  const times = decisionRecords(records.map(normalize), annotations).map(item => Date.parse(item.valid_time));
  return [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b);
}
function label(m) {
  if (!m.reviewed || !['decision','change'].includes(m.kind)) return null;
  if (m.lifecycle === 'cancelled') return '已取消';
  if (m.lifecycle === 'superseded') return '已替代';
  return ({confirmed:'已确定', proposed:'待决定', uncertain:'待核实'})[m.basis] || null;
}
function renderNative(item, annotations) {
  const m = meta(item);
  const legacyTodo=m.reviewed && m.kind==='todo',task=legacyTodo && item.source?.harness && item.source?.instance && item.source?.session ? taskView(sourceRoot(item),annotations,m.lifecycle==='cancelled') : null;
  return {time:stamp(item), topic:topic(item), kind:m.reviewed ? (m.kind || 'source') : 'source', label:label(m), text:m.reviewed ? (item.text || item.title || '') : '', ...(task?{task_state:task}:{}), next_step:legacyTodo && (!task || ['unmarked','open'].includes(task.state)) ? (m.next_step || item.text || '') : null, revises:m.reviewed && Array.isArray(m.revises) ? m.revises : [], citation:citation(item), annotations:annotations.filter(a => a.kind === 'annotation' && a.target && a.target.id === item.id && a.target.revision === item.revision).map(a => ({id:a.id,kind:a.kind,text:a.text}))};
}
function renderAnnotation(a, target, annotations) {
  const task=a.kind==='todo'?taskView(annotationRoot(a),annotations,a.lifecycle==='cancelled'):null;
  return {time:a.valid_time || stamp(target),topic:a.topic || topic(target),kind:a.kind,label:a.kind === 'todo' ? null : label({reviewed:true,kind:a.kind,basis:a.basis || 'confirmed',lifecycle:a.lifecycle || 'active'}),text:a.text,...(task?{task_state:task}:{}),next_step:task && ['unmarked','open'].includes(task.state) ? a.text : null,revises:a.revises || [],citation:a.target,review_id:a.id,...(lineage(a)?{candidateLineage:lineage(a)}:{}),annotations:annotations.filter(note => note.kind === 'correction' && note.revises === a.id).map(note => ({id:note.id,kind:note.kind,text:note.text,...(note.evidence ? {evidence:note.evidence} : {})}))};
}
function matches(item, args) {
  const time = stamp(item);
  if (!matchesTime(time,args)) return false;
  const q = String(args.keyword || '').toLocaleLowerCase().trim();
  return !q || [item.title, item.text, meta(item).topic, meta(item).next_step].some(v => typeof v === 'string' && v.toLocaleLowerCase().includes(q));
}
function inScope(item, s) {
  const owner = item.owner ?? item.scope?.owner;
  const project = item.project ?? item.scope?.project;
  // Archive is responsible for scoped retrieval; reject records that explicitly disagree.
  return (owner === undefined || owner === s.owner) && (project === undefined || project === s.project);
}
function createQuery(archive) {
  if (!archive || typeof archive.listItems !== 'function' || typeof archive.getItem !== 'function') throw new Error('archive required');
  async function items(args, options = {}) {
    const s = scope(args); bounds(args);
    const result = await archive.listItems(s, {from:args.from,to:args.to,toExclusive:args.toExclusive,keyword:args.keyword,topic:options.withTopic ? args.topic : undefined,reviewOnly:options.reviewOnly,reviewedTimeline:options.reviewedTimeline,compactReviewTargets:options.compactReviewTargets,summaries:options.summaries});
    const list = Array.isArray(result) ? result : result.items;
    if (!Array.isArray(list)) throw new Error('invalid archive response');
    return list.map(normalize).filter(i => inScope(i, s) && matches(i, args));
  }
  async function reviewTargets(args, list, annotations) {
    const s = scope(args), keyword = String(args.keyword || '').trim();
    const native = new Map(list.map(item => [targetKey(item.id,item.revision),item]));
    const fetched = new Map();
    const results = [];
    for (const annotation of annotations) {
      const ref = annotation.target;
      if (!ref || !['decision','change','todo'].includes(annotation.kind)) continue;
      const key = targetKey(ref.id,ref.revision);
      const nativeMatch = native.get(key);
      let target = nativeMatch;
      if (!target && keyword && matches({title:annotation.topic,text:annotation.text}, {keyword})) {
        if (!fetched.has(key)) {
          const record = await archive.getItem({...s,id:ref.id,revision:ref.revision,source:ref.source});
          const item = record && normalize(record);
          fetched.set(key, item && inScope(item,s) && item.id === ref.id && item.revision === ref.revision &&
            matches(item,{from:args.from,to:args.to,toExclusive:args.toExclusive}) ? item : null);
        }
        target = fetched.get(key);
      }
      if (target) results.push({annotation,target,nativeMatch:Boolean(nativeMatch)});
    }
    return results;
  }
  // Annotations for a reviewed view can only affect rows rooted in its source
  // versions. Read exact targets instead of the entire scoped history. Filter
  // again for adapters that return a superset. The full task-state history for each root is retained.
  async function reviewedDependencies(args, list) {
    if (!list.length || typeof archive.listAnnotations !== 'function') return [];
    const scoped = scope(args);
    const byTarget = new Map(list.map(item => [targetKey(item.id,item.revision),item]));
    const targets = [...byTarget.values()].map(item => ({id:item.id,revision:item.revision}));
    // Older third-party archive adapters may not implement the bulk method.
    // Their scope-wide result preserves the original order and semantics.
    const all = typeof archive.listAnnotationsForTargets === 'function'
      ? await archive.listAnnotationsForTargets(scoped,targets)
      : await archive.listAnnotations(scoped);
    const rows = all.filter(a =>
      inScope(a,scoped) && byTarget.has(targetKey(a.target?.id,a.target?.revision))
    );
    const roots = rows.filter(a => {
      if (!['decision','change','todo'].includes(a.kind)) return false;
      const target = byTarget.get(targetKey(a.target.id,a.target.revision));
      return !args.topic || (a.topic || topic(target)) === args.topic;
    });
    const rootIds = new Set(roots.map(a => a.id));
    const taskRoots = new Set(roots.filter(a => a.kind==='todo').map(a => rootKey(annotationRoot(a))));
    const native = list.filter(item =>
      (!args.topic || topic(item)===args.topic) && meta(item).reviewed &&
      ['decision','change','todo'].includes(meta(item).kind)
    );
    for (const item of native) {
      if (meta(item).kind==='todo' && item.source?.harness && item.source?.instance && item.source?.session)
        taskRoots.add(rootKey(sourceRoot(item)));
    }
    const nativeTargets = new Set(native.map(item => targetKey(item.id,item.revision)));
    const nativeIds = new Set(native.map(item => item.id));
    return rows.filter(a => rootIds.has(a.id) ||
      (a.kind==='correction' && (rootIds.has(a.revises) || nativeIds.has(a.revises))) ||
      (a.kind==='annotation' && nativeTargets.has(targetKey(a.target?.id,a.target?.revision))) ||
      (a.kind==='task-state' && a.taskRoot && taskRoots.has(rootKey(a.taskRoot))));
  }
  async function timelineRows(args, reviewedOnly, list, annotations) {
      const filtered = (args.topic ? list.filter(i => topic(i) === args.topic) : list).filter(i => !reviewedOnly || (meta(i).reviewed && ['decision','change','todo'].includes(meta(i).kind)));
      const rows = filtered.sort((a,b) => compareTime(stamp(a),stamp(b)) || (reviewedOnly ? Buffer.compare(Buffer.from(String(a.id)),Buffer.from(String(b.id))) : String(a.id).localeCompare(String(b.id)))).map(item => ({time:stamp(item), sourceTime:stamp(item), build:() => renderNative(item,annotations)}));
      for (const {annotation:a,target} of await reviewTargets(args,list,annotations)) {
        if (args.topic && (a.topic || topic(target)) !== args.topic) continue;
        rows.push({time:a.valid_time || stamp(target),sourceTime:stamp(target),build:()=>renderAnnotation(a,target,annotations)});
      }
      rows.sort((a,b) => compareTime(a.time,b.time));
      return {rows,filtered};
  }
  async function timeline(args, reviewedOnly = false, page = null) {
      const list = await items(args,{withTopic:true,reviewOnly:reviewedOnly,reviewedTimeline:reviewedOnly});
      const annotations = reviewedOnly ? await reviewedDependencies(args,list) : typeof archive.listAnnotations === 'function' ? await archive.listAnnotations(scope(args)) : [];
      const {rows,filtered}=await timelineRows(args,reviewedOnly,list,annotations);
      if (page) {
        // Archived versions and scoped annotation IDs identify immutable rows.
        const rowTargets=new Set(filtered.map(item=>targetKey(item.id,item.revision)));
        for (const a of annotations) if (['decision','change','todo'].includes(a.kind)) rowTargets.add(targetKey(a.target?.id,a.target?.revision));
        const identities = ['reviewed-order-v2',list.filter(item=>rowTargets.has(targetKey(item.id,item.revision))).map(item => [item.id,item.revision]), annotations.map(annotation => annotation.id)];
        const selected=reviewedPage(rows,page.binding,page.limit,page.cursor,identities);
        return {rows:selected.rows.map(row=>row.build()),nextCursor:selected.nextCursor};
      }
      return rows.map(row=>row.build());
    }
  function evaluateCurrent(args,list,annotations) {
      const asOf = Date.parse(args.asOf || new Date().toISOString());
      const records = decisionRecords(list, annotations).filter(item =>
        (!args.topic || topic(item) === args.topic) && (!item.valid_time || Date.parse(item.valid_time) <= asOf));
      const groups = new Map();
      for (const record of records) { const name = topic(record); if (!groups.has(name)) groups.set(name,[]); groups.get(name).push(record); }
      return [...groups].sort(([a],[b]) => a.localeCompare(b)).map(([name, group]) => {
        const referenced = new Set(), links = new Map(); let invalid = false;
        for (const item of group) {
          const m = meta(item);
          if (m.kind !== 'change' || m.basis !== 'confirmed') continue;
          const targets = Array.isArray(m.revises) ? m.revises : [];
          if (!targets.length) invalid = true;
          for (const id of targets) {
            const matches = group.filter(candidate => candidate.id === id && candidate !== item);
            if (matches.length !== 1 || (item.valid_time && matches[0].valid_time && Date.parse(item.valid_time) < Date.parse(matches[0].valid_time))) invalid = true; else { referenced.add(matches[0]); if (!links.has(item)) links.set(item,[]); links.get(item).push(matches[0]); }
          }
        }
        const visiting = new Set(), visited = new Set();
        function visit(node) { if (visiting.has(node)) { invalid = true; return; } if (visited.has(node)) return; visiting.add(node); for (const target of links.get(node) || []) visit(target); visiting.delete(node); visited.add(node); }
        for (const item of group) visit(item);
        const pending = group.filter(item => meta(item).kind === 'change' && meta(item).basis !== 'confirmed');
        const heads = group.filter(item => !referenced.has(item) && !pending.includes(item));
        if (heads.length !== 1 || invalid) return {topic:name,label:'待核实',reason:'ambiguous decisions or change references',candidates:heads.map(citation)};
        const item = heads[0];
        const corrections = annotations.filter(a => a.kind === 'correction' && a.target?.id === citation(item).id && a.target?.revision === citation(item).revision && a.revises === item.id);
        if (corrections.length > 1 || corrections.some(a => a.evidence && a.evidence.id === citation(item).id && a.evidence.revision === citation(item).revision)) return {topic:name,label:'待核实',reason:'correction target requires review',citation:citation(item),corrections:corrections.map(a => ({id:a.id,text:a.text,...(a.evidence ? {evidence:a.evidence} : {})}))};
        return {topic:name,label:label(meta(item)) || '待核实',kind:meta(item).kind,review_id:item.evidenceCitation ? item.id : null,...(item.candidateLineage?{candidateLineage:item.candidateLineage}:{}),text:corrections.length ? corrections[0].text : (item.text || item.title || ''),citation:citation(item),correction:corrections.length ? {id:corrections[0].id,text:corrections[0].text,...(corrections[0].evidence ? {evidence:corrections[0].evidence} : {})} : null,...(corrections[0]?.evidence ? {effectiveCitation:corrections[0].evidence} : {}),pending:pending.map(i => ({review_id:i.id,label:label(meta(i)),text:i.text,citation:citation(i)}))};
      });
  }
  return {
    async find(args) {
      const list = await items(args, {summaries: !String(args.keyword || '').trim()});
      const groups = new Map();
      for (const item of list) {
        const name = topic(item);
        const group = groups.get(name) || {topic:name, count:0, latest:'', citations:[]};
        group.count++; if (compareTime(stamp(item), group.latest, true) < 0) group.latest = stamp(item);
        group.citations.push(citation(item)); groups.set(name, group);
      }
      if (typeof archive.listAnnotations === 'function') {
        const annotations = await archive.listAnnotations(scope(args));
        for (const {annotation:a,target:source,nativeMatch} of await reviewTargets(args,list,annotations)) {
          if (!a.topic || (nativeMatch && a.topic === topic(source))) continue;
          const group = groups.get(a.topic) || {topic:a.topic,count:0,latest:'',citations:[]};
          group.count++; if (compareTime(stamp(source), group.latest, true) < 0) group.latest = stamp(source);
          group.citations.push(citation(source)); groups.set(a.topic,group);
        }
      }
      const limit = Math.max(1, Math.min(20, Number.isInteger(args.limit) ? args.limit : 5));
      const sorted = [...groups.values()].sort((a,b) => compareTime(a.latest,b.latest,true) || a.topic.localeCompare(b.topic));
      const offset = Math.max(0, Number.isInteger(args.offset) ? args.offset : 0);
      const topics = sorted.slice(offset,offset + limit);
      return {topics,coverage:{scope:'imported records',returned:topics.length,total:sorted.length,offset,has_more:offset + limit < sorted.length}};
    },
    async timeline(args) { return timeline(args); },
    async reviewedTimeline(args) { if (String(args.keyword || '').trim()) throw new Error('keyword is not supported for reviewed timeline'); return timeline(args,true); },
    async reviewedGraph(args) {
      if (String(args.keyword || '').trim()) throw new Error('keyword is not supported for reviewed timeline');
      bounds(args);
      const unbounded={...scope(args),topic:args.topic,asOf:args.asOf};
      const list=await items(unbounded,{withTopic:true,reviewOnly:true,reviewedTimeline:true});
      const annotations=await reviewedDependencies(unbounded,list);
      const {rows}=await timelineRows(unbounded,true,list,annotations);
      const all=rows.map(row=>row.build());
      // Graph membership uses source time, while the public row can display
      // a different review effective time. Keep the rendered rows shared.
      const filtered=args.from!==undefined || args.to!==undefined
        ? all.filter((_,index)=>matchesTime(rows[index].sourceTime,args)) : all;
      return {all,filtered,current:evaluateCurrent(unbounded,list,annotations)};
    },
    async reviewedTimelinePage(args) {
      const scoped=scope(args); bounds(args);
      if (typeof args.topic !== 'string' || !args.topic.trim()) throw new Error('topic required');
      if (String(args.keyword || '').trim()) throw new Error('keyword is not supported for reviewed timeline');
      const limit=args.limit === undefined ? 20 : Number(args.limit);
      if (!Number.isInteger(limit) || limit<1 || limit>50) throw new Error('invalid reviewed timeline limit');
      const binding=JSON.stringify([scoped.owner,scoped.project,archive.backend,args.topic,args.from ?? null,args.to ?? null,Boolean(args.toExclusive)]);
      if (archive.backend === 'sqlite' && typeof archive.reviewedHistoryPage === 'function') {
        const position=parseReviewedSqliteCursor(args.cursor,binding);
        const page=await archive.reviewedHistoryPage(scoped,args,position,limit);
        const annotations=page.dependencies;
        const rows=page.entries.map(({record,annotation}) => {
          const item=normalize(record);
          return annotation ? renderAnnotation(annotation,item,annotations) : renderNative(item,annotations);
        });
        return {rows,nextCursor:encodeReviewedSqliteCursor(page.next,binding)};
      }
      return timeline(args,true,{binding,limit,cursor:args.cursor});
    },
    async topicSources(args) {
      const scoped=scope(args); bounds(args);
      if (typeof args.topic !== 'string' || !args.topic.trim()) throw new Error('topic required');
      if (args.keyword) throw new Error('keyword is not supported for topic sources');
      const limit=args.limit === undefined ? 20 : Number(args.limit);
      if (!Number.isInteger(limit) || limit<1 || limit>50) throw new Error('invalid topic source limit');
      const binding=JSON.stringify([scoped.owner,scoped.project,args.topic,args.from ?? null,args.to ?? null,Boolean(args.toExclusive)]);
      let cursor=null;
      if (args.cursor !== undefined) {
        try { const parsed=JSON.parse(Buffer.from(args.cursor,'base64url').toString());
          if (parsed.binding!==binding || parsed.backend!==archive.backend || !parsed.position || typeof parsed.position!=='object') throw Error();
          cursor=parsed.position;
          if (archive.backend==='sqlite' && (!Number.isSafeInteger(cursor.after) || cursor.after<0 || !Number.isSafeInteger(cursor.fence) || cursor.fence<cursor.after)) throw Error();
          if (archive.backend==='json' && (typeof cursor.after!=='string' || !/^[a-f0-9]{64}$/.test(cursor.fingerprint))) throw Error();
        } catch { throw new Error('invalid topic source cursor'); }
      }
      const page=await archive.topicSources(scoped,args,cursor,limit);
      const rows=page.records.map(normalize).map(item=>({time:stamp(item),topic:topic(item),kind:'source',label:null,text:'',next_step:null,revises:[],citation:citation(item),annotations:[]}));
      return {rows,nextCursor:page.next ? Buffer.from(JSON.stringify({binding,backend:archive.backend,position:page.next})).toString('base64url') : null};
    },
    async taskList(args) {
      const s=scope(args), records=(await archive.listItems(s,{taskOnly:true})).map(normalize).filter(item=>inScope(item,s));
      const annotations=await archive.listAnnotations(s), tasks=[];
      const targets = new Map(records.map(item => [targetKey(item.id,item.revision),item]));
      for(const item of records){const m=meta(item);if(m.reviewed!==true || m.kind!=='todo' || !item.source?.harness || !item.source?.instance || !item.source?.session)continue;const root=sourceRoot(item),state=taskView(root,annotations,m.lifecycle==='cancelled');if(!['completed','cancelled'].includes(state.state))tasks.push({root,target:{id:item.id,revision:item.revision,source:cleanSource(item.source)},text:item.text||item.title||'',...state,next_step:['unmarked','open'].includes(state.state)?(m.next_step||item.text||''):null})}
      for(const a of annotations){if(a.kind!=='todo')continue;const item=targets.get(targetKey(a.target?.id,a.target?.revision));if(!item || !item.source?.harness || !item.source?.instance || !item.source?.session)continue;const root=annotationRoot(a),state=taskView(root,annotations,a.lifecycle==='cancelled');if(!['completed','cancelled'].includes(state.state))tasks.push({root,target:{id:item.id,revision:item.revision,source:cleanSource(item.source)},text:a.text,...(lineage(a)?{candidateLineage:lineage(a)}:{}),...state,next_step:['unmarked','open'].includes(state.state)?a.text:null})}
      tasks.sort((a,b)=>{const x=JSON.stringify(a.root),y=JSON.stringify(b.root);return x<y?-1:x>y?1:0});
      return {tasks};
    },
    async current(args) {
      const list = await items(args,{withTopic:true,reviewOnly:true,compactReviewTargets:true});
      const annotations = await reviewedDependencies(args,list);
      return evaluateCurrent(args,list,annotations);
    },
    async evidence(args) {
      const s = scope(args);
      if (typeof args.id !== 'string' || !args.id || typeof args.revision !== 'string' || !args.revision) throw new Error('id and exact revision are required');
      if (args.source !== undefined && (!args.source || typeof args.source !== 'object' || Array.isArray(args.source) || ['harness','instance','session'].some(k => typeof args.source[k] !== 'string' || !args.source[k].trim()))) throw new Error('invalid evidence source');
      const record = await archive.getItem({...s, id:args.id, revision:args.revision, ...(args.source !== undefined ? {source:args.source} : {})});
      const item = record && normalize(record);
      if (!item || !inScope(item,s) || item.id !== args.id || item.revision !== args.revision || (args.source !== undefined && ['harness','instance','session'].some(k => item.source?.[k] !== args.source[k]))) throw new Error('evidence not found');
      const { original: reference, ...metadata } = meta(item);
      return { ...item, ...(item.metadata ? { metadata } : {}), original: await originalAvailability(archive.dir, reference) };
    },
    async annotations(args) {
      const s = scope(args), target = args.target;
      const sourceKeys = ['harness','instance','session'];
      const sameSource = (a,b) => sourceKeys.every(k => a?.[k] === b[k]);
      if (target !== undefined) {
        const {id,revision,source} = target || {};
        if (typeof id !== 'string' || !id.trim() || typeof revision !== 'string' || !revision.trim() ||
            !source || sourceKeys.some(k => typeof source[k] !== 'string' || !source[k].trim())) {
          throw new Error('exact annotation target required');
        }
        const record = await archive.getItem({...s,id,revision,source});
        const item = record && normalize(record);
        if (!item || !inScope(item,s) || item.id !== id || item.revision !== revision || !sameSource(item.source,source)) {
          throw new Error('evidence not found');
        }
      }
      const rows = await archive.listAnnotations(s,target);
      return rows.filter(a => !target || (a.target?.id === target.id && a.target?.revision === target.revision &&
        (!a.target.source || sameSource(a.target.source,target.source))))
        .map(({candidateReview,...record}) => ({...record,...(candidateReview ? {candidateLineage:lineage({candidateReview})} : {})}));
    },
    async annotate(args) { const s = scope(args); return archive.addAnnotation({...args, scope:s}); }
  };
}
module.exports = {createQuery, label, decisionBoundaries};
