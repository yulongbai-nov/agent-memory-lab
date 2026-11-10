'use strict';

const { originalAvailability } = require('./originals.cjs');

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
function decisionRecords(items, annotations) {
  const targetKey = (id, revision) => JSON.stringify([id, revision]);
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
function matches(item, args) {
  const time = stamp(item);
  if (args.from && (!time || time < args.from)) return false;
  if (args.to && (!time || time > args.to)) return false;
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
    const s = scope(args);
    const result = await archive.listItems(s, {from:args.from,to:args.to,keyword:args.keyword,topic:options.withTopic ? args.topic : undefined,reviewOnly:options.reviewOnly,summaries:options.summaries});
    const list = Array.isArray(result) ? result : result.items;
    if (!Array.isArray(list)) throw new Error('invalid archive response');
    return list.map(normalize).filter(i => inScope(i, s) && matches(i, args));
  }
  return {
    async find(args) {
      const list = await items(args, {summaries: !String(args.keyword || '').trim()});
      const groups = new Map();
      for (const item of list) {
        const name = topic(item);
        const group = groups.get(name) || {topic:name, count:0, latest:'', citations:[]};
        group.count++; if (stamp(item) > group.latest) group.latest = stamp(item);
        group.citations.push(citation(item)); groups.set(name, group);
      }
      if (typeof archive.listAnnotations === 'function') {
        const annotations = await archive.listAnnotations(scope(args));
        for (const a of annotations) {
          if (!a.topic || !['decision','change','todo'].includes(a.kind)) continue;
          const source = list.find(i => i.id === a.target?.id && i.revision === a.target?.revision);
          if (!source || a.topic === topic(source)) continue;
          const group = groups.get(a.topic) || {topic:a.topic,count:0,latest:'',citations:[]};
          group.count++; if (stamp(source) > group.latest) group.latest = stamp(source);
          group.citations.push(citation(source)); groups.set(a.topic,group);
        }
      }
      const limit = Math.max(1, Math.min(20, Number.isInteger(args.limit) ? args.limit : 5));
      const sorted = [...groups.values()].sort((a,b) => b.latest.localeCompare(a.latest) || a.topic.localeCompare(b.topic));
      const offset = Math.max(0, Number.isInteger(args.offset) ? args.offset : 0);
      const topics = sorted.slice(offset,offset + limit);
      return {topics,coverage:{scope:'imported records',returned:topics.length,total:sorted.length,offset,has_more:offset + limit < sorted.length}};
    },
    async timeline(args) {
      const list = await items(args,{withTopic:true});
      const filtered = args.topic ? list.filter(i => topic(i) === args.topic) : list;
      const annotations = typeof archive.listAnnotations === 'function' ? await archive.listAnnotations(scope(args)) : [];
      const rows = filtered.sort((a,b) => stamp(a).localeCompare(stamp(b)) || String(a.id).localeCompare(String(b.id))).map(item => {
        const m = meta(item);
        return {time:stamp(item), topic:topic(item), kind:m.reviewed ? (m.kind || 'source') : 'source', label:label(m), text:m.reviewed ? (item.text || item.title || '') : '', next_step:m.reviewed && m.kind === 'todo' ? (m.next_step || item.text || '') : null, revises:m.reviewed && Array.isArray(m.revises) ? m.revises : [], citation:citation(item), annotations:annotations.filter(a => a.kind === 'annotation' && a.target && a.target.id === item.id && a.target.revision === item.revision).map(a => ({id:a.id,kind:a.kind,text:a.text}))};
      });
      for (const a of annotations.filter(a => ['decision','change','todo'].includes(a.kind))) {
        const target = list.find(i => i.id === a.target?.id && i.revision === a.target?.revision);
        if (!target || (args.topic && (a.topic || topic(target)) !== args.topic)) continue;
        rows.push({time:a.valid_time || stamp(target),topic:a.topic || topic(target),kind:a.kind,label:a.kind === 'todo' ? null : label({reviewed:true,kind:a.kind,basis:a.basis || 'confirmed',lifecycle:a.lifecycle || 'active'}),text:a.text,next_step:a.kind === 'todo' ? a.text : null,revises:a.revises || [],citation:a.target,review_id:a.id,annotations:annotations.filter(note => note.kind === 'correction' && note.revises === a.id).map(note => ({id:note.id,kind:note.kind,text:note.text}))});
      }
      return rows.sort((a,b) => a.time.localeCompare(b.time));
    },
    async current(args) {
      const list = await items(args,{withTopic:true,reviewOnly:true});
      const annotations = typeof archive.listAnnotations === 'function' ? await archive.listAnnotations(scope(args)) : [];
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
        if (corrections.length > 1) return {topic:name,label:'待核实',reason:'correction target requires review',citation:citation(item),corrections:corrections.map(a => ({id:a.id,text:a.text}))};
        return {topic:name,label:label(meta(item)) || '待核实',kind:meta(item).kind,review_id:item.evidenceCitation ? item.id : null,text:corrections.length ? corrections[0].text : (item.text || item.title || ''),citation:citation(item),correction:corrections.length ? {id:corrections[0].id,text:corrections[0].text} : null,pending:pending.map(i => ({review_id:i.id,label:label(meta(i)),text:i.text,citation:citation(i)}))};
      });
    },
    async evidence(args) {
      const s = scope(args);
      if (typeof args.id !== 'string' || !args.id || typeof args.revision !== 'string' || !args.revision) throw new Error('id and exact revision are required');
      const record = await archive.getItem({...s, id:args.id, revision:args.revision, source:args.source});
      const item = record && normalize(record);
      if (!item || !inScope(item,s) || item.id !== args.id || item.revision !== args.revision) throw new Error('evidence not found');
      const { original: reference, ...metadata } = meta(item);
      return { ...item, ...(item.metadata ? { metadata } : {}), original: await originalAvailability(archive.dir, reference) };
    },
    async annotations(args) { const s = scope(args); return archive.listAnnotations(s); },
    async annotate(args) { const s = scope(args); return archive.addAnnotation({...args, scope:s}); }
  };
}
module.exports = {createQuery, label, decisionBoundaries};
