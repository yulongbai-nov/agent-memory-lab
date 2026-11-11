'use strict';
const { originalAvailability } = require('./originals.cjs');
const { previewProjections, verifiedProjections } = require('./local-derive-projection.cjs');

function scrub(text) {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[LINK]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/(?:\/Users\/|\/home\/|\/private\/)[^\s"']+/g, '[PATH]')
    .replace(/\b(?:Bearer|token|secret|password|api[_-]?key|credential)\s*(?:[:=]\s*|\s+)[^\s,;"']+/gi, '[SECRET]')
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, '[IDENTIFIER]')
    .replace(/\+?\d[\d .()-]{6,}\d/g, '[NUMBER]');
}
const MAX_ORIGINAL_CHECKS = 24;
const acknowledge = text => /^(?:ok(?:ay)?|sure|yes|no|thanks?|thank you|got it|sounds good|好的?|是的|收到|明白|谢谢|可以|嗯)[\s.!。！,，]*$/i.test(text.trim());
function score(text) {
  let n = 0;
  if (/\b(decid(?:e|ed|ing)|decision|agreed|choose|chosen|confirm(?:ed)?|settled)\b|决定|确定|选择|同意|确认/i.test(text)) n += 5;
  if (/\b(chang(?:e|ed)|instead|revis(?:e|ed)|correct(?:ion)?|misunderst(?:ood|anding))\b|更改|改为|改变|纠正|误解|不是/i.test(text)) n += 5;
  if (/\b(todo|next step|follow.up|need to|will|must|prepare|finish|pending)\b|待办|下一步|接下来|需要|完成|准备|尚未/i.test(text)) n += 4;
  return n;
}
function projectionChoices(text) {
  return previewProjections(text, score).filter(choice => choice.text.trim() && scrub(choice.text) === choice.text && !acknowledge(choice.text));
}
function aliasInputs(records) {
  return records.map((record,index)=>({
    source:'source-1',item:'message-'+(index+1),version:'v1',text:record.text,
    ...(record.projection?.kind === 'relay-input' ? {view:'relay-excerpt'} :
      record.projection?.kind === 'fragment' ? {view:'excerpt'} : {})
  }));
}

function withinBatch(records) {
  return records.length <= 5 && records.reduce((bytes,r)=>bytes+Buffer.byteLength(r.text),0) <= 650 &&
    Buffer.byteLength(JSON.stringify(aliasInputs(records))) <= 800;
}

async function selectLocalBatch(archive, scope) {
  const groups = new Map(), seen = new Set();
  let unavailableConsidered = 0, skippedProjectionConsidered = 0;
  for (const row of await archive.localDeriveMessages(scope)) {
    const {item, source} = row;
    if (!item || !source || typeof item.text !== 'string' || !item.turnId || !['user','assistant'].includes(item.role)) continue;
    const sourceId = [source.harness,source.instance,source.session].join('/');
    const itemKey = JSON.stringify([sourceId,item.id]);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    const available = await originalAvailability(archive.dir,item.metadata?.original);
    if (available.availability !== 'archived') { unavailableConsidered++; continue; }
    const choices = projectionChoices(item.text);
    if (!choices.length) { skippedProjectionConsidered++; continue; }
    const turnKey = JSON.stringify([sourceId,item.turnId]);
    if (!groups.has(turnKey)) groups.set(turnKey,[]);
    groups.get(turnKey).push({row,sourceId,choices,score:Math.max(...choices.map(choice=>score(choice.text)))});
  }
  const eligible = [...groups.values()].filter(group => group.some(entry => entry.row.item.role === 'user'));
  eligible.sort((a,b) => Math.max(...b.map(r=>r.score)) - Math.max(...a.map(r=>r.score)) ||
    Number(b.some(r=>r.row.item.role === 'assistant')) - Number(a.some(r=>r.row.item.role === 'assistant')));
  let originalsChecked = 0;
  let records = [];
  for (const group of eligible) {
    const selected = [];
    const ordered = [...group].sort((a,b) => Number(b.row.item.role === 'user') - Number(a.row.item.role === 'user') ||
      b.score-a.score || (a.row.item.metadata?.coordinate ?? 0)-(b.row.item.metadata?.coordinate ?? 0));
    for (const {row,sourceId,choices} of ordered) {
      if (selected.length >= 5 || originalsChecked >= MAX_ORIGINAL_CHECKS) break;
      if (!selected.length && row.item.role !== 'user') break;
      originalsChecked++;
      const verified = await verifiedProjections(archive.dir,row,choices);
      if (!verified.length) { skippedProjectionConsidered++; continue; }
      const base = {source:sourceId,item:row.item.id,version:row.versionId};
      const options = verified.map(({text,projection})=>({...base,text,projection}));
      const match = options.find(candidate=>withinBatch([...selected.map(entry=>entry.record),candidate]));
      if (match) selected.push({record:match,coordinate:row.item.metadata?.coordinate ?? 0});
    }
    if (selected.length) {
      selected.sort((a,b)=>a.coordinate-b.coordinate || a.record.item.localeCompare(b.record.item));
      records = selected.map(entry=>entry.record);
      break;
    }
    if (originalsChecked >= MAX_ORIGINAL_CHECKS) break;
  }
  return {records,availability:{archived:records.length,unavailableConsidered,skippedProjectionConsidered}};
}
module.exports = {selectLocalBatch,aliasInputs,projectionChoices};
