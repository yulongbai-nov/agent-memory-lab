'use strict';
const { originalAvailability } = require('./originals.cjs');

function scrub(text) {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[LINK]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/(?:\/Users\/|\/home\/|\/private\/)[^\s"']+/g, '[PATH]')
    .replace(/\b(?:Bearer|token|secret|password|api[_-]?key|credential)\s*(?:[:=]\s*|\s+)[^\s,;"']+/gi, '[SECRET]')
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, '[IDENTIFIER]')
    .replace(/\+?\d[\d .()-]{6,}\d/g, '[NUMBER]');
}
const acknowledge = text => /^(?:ok(?:ay)?|sure|yes|no|thanks?|thank you|got it|sounds good|好的?|是的|收到|明白|谢谢|可以|嗯)[\s.!。！,，]*$/i.test(text.trim());
function score(text) {
  let n = 0;
  if (/\b(decid(?:e|ed|ing)|decision|agreed|choose|chosen|confirm(?:ed)?|settled)\b|决定|确定|选择|同意|确认/i.test(text)) n += 5;
  if (/\b(chang(?:e|ed)|instead|revis(?:e|ed)|correct(?:ion)?|misunderst(?:ood|anding))\b|更改|改为|改变|纠正|误解|不是/i.test(text)) n += 5;
  if (/\b(todo|next step|follow.up|need to|will|must|prepare|finish|pending)\b|待办|下一步|接下来|需要|完成|准备|尚未/i.test(text)) n += 4;
  return n;
}
async function selectLocalBatch(archive, scope) {
  const groups = new Map(), seen = new Set();
  let unavailableConsidered = 0;
  for (const row of await archive.localDeriveMessages(scope)) {
    const {item, source, versionId} = row;
    if (!item || !source || typeof item.text !== 'string' || !item.turnId || !['user','assistant'].includes(item.role)) continue;
    const sourceId = [source.harness,source.instance,source.session].join('/');
    const itemKey = JSON.stringify([sourceId,item.id]);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    const available = await originalAvailability(archive.dir,item.metadata?.original);
    if (available.availability !== 'archived') { unavailableConsidered++; continue; }
    const text = item.text;
    if (scrub(text) !== text || !text.trim() || Buffer.byteLength(text) > 450 || acknowledge(text)) continue;
    const turnKey = JSON.stringify([sourceId,item.turnId]);
    if (!groups.has(turnKey)) groups.set(turnKey,[]);
    groups.get(turnKey).push({role:item.role, coordinate:item.metadata?.coordinate ?? 0,
      source:sourceId,item:item.id,version:versionId,text,score:score(text)});
  }
  const eligible = [...groups.values()].filter(group => group.some(row => row.role === 'user'));
  // Stable ties preserve the SQL's newest-first turn order.
  eligible.sort((a,b) => Math.max(...b.map(r=>r.score)) - Math.max(...a.map(r=>r.score)) ||
    Number(b.some(r=>r.role === 'assistant')) - Number(a.some(r=>r.role === 'assistant')));
  const group = eligible[0] || [], selected = [];
  const user = group.filter(r=>r.role === 'user').sort((a,b)=>b.score-a.score || a.coordinate-b.coordinate)[0];
  const ordered = user ? [user,...group.filter(r=>r!==user).sort((a,b)=>b.score-a.score || a.coordinate-b.coordinate)] : [];
  for (const row of ordered) {
    if (selected.length >= 5) break;
    const candidate = [...selected,row];
    // Match the small alias envelope used by the prompt and account for JSON escaping.
    const aliases = candidate.map((r,i)=>({source:'source-1',item:'message-'+(i+1),version:'v1',text:r.text}));
    if (candidate.reduce((n,r)=>n+Buffer.byteLength(r.text),0) > 650 || Buffer.byteLength(JSON.stringify(aliases)) > 900) continue;
    selected.push(row);
  }
  selected.sort((a,b) => a.coordinate-b.coordinate || a.item.localeCompare(b.item));
  return {records:selected.map(({source,item,version,text})=>({source,item,version,text})),
    availability:{archived:selected.length,unavailableConsidered}};
}
module.exports = {selectLocalBatch};
