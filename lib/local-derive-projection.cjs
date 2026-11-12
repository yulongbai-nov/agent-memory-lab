'use strict';
const {readVerifiedOriginal} = require('./originals.cjs');

const LIMIT = 450, MAX_INPUT = 1024 * 1024;
function visible(text) {
  const relay = /^\s*<realtime_delegation>\s*<source_thread_id>[A-Za-z0-9-]+<\/source_thread_id>\s*<input>([^<>]*?)<\/input>\s*<\/realtime_delegation>\s*$/du.exec(text);
  if (relay) {
    if (/realtime_delegation|transcript_delta|source_thread_id|&lt;[^&]+&gt;/i.test(relay[1])) return null;
    return {kind:'relay-input',start:relay.indices[1][0],end:relay.indices[1][1]};
  }
  if (/realtime_delegation|transcript_delta|source_thread_id|<[^>]+>|&lt;[^&]+&gt;/i.test(text)) return null;
  return {kind:'plain',start:0,end:text.length};
}
function trimmed(text,start,end) {
  while(start<end && /\s/u.test(text[start])) start++;
  while(end>start && /\s/u.test(text[end-1])) end--;
  return {start,end,text:text.slice(start,end)};
}
function previewProjections(text, score = () => 0) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INPUT || typeof score !== 'function') return [];
  const range = visible(text); if (!range) return [];
  const part = trimmed(text,range.start,range.end);
  if (!part.text) return [];
  const whole = range.kind === 'plain' ? {start:0,end:text.length,text} : part;
  const full = Buffer.byteLength(whole.text) <= LIMIT ? {kind:range.kind === 'relay-input' ? 'relay-input' : 'full',...whole} : null;
  const found = [], seen = new Set(full ? [`${part.start}:${part.end}`] : []);
  function add(start,end) {
    const p = trimmed(text,start,end);
    if (!p.text || Buffer.byteLength(p.text)>LIMIT) return;
    const key = `${p.start}:${p.end}`; if (seen.has(key)) return; seen.add(key);
    let rank = Number(score(p.text)); if (!Number.isFinite(rank)) rank = 0;
    found.push({kind:range.kind === 'relay-input' ? 'relay-input' : 'fragment',...p,rank});
  }
  const body = text.slice(part.start,part.end);
  for (const s of new Intl.Segmenter('zh',{granularity:'sentence'}).segment(body)) {
    const begin=part.start+s.index, end=begin+s.segment.length;
    if (Buffer.byteLength(s.segment)<=LIMIT) { add(begin,end); continue; }
    let start=begin;
    for (let i=begin;i<end;i++) if (/[,，;；:：]/u.test(text[i])) { add(start,i+1); start=i+1; }
    add(start,end);
    // Bounded fallback windows end at UTF-16 codepoint boundaries.
    let w=begin, bytes=0;
    for (let i=begin;i<end;) {
      const cp=text.codePointAt(i), width=cp>0xffff?2:1, n=Buffer.byteLength(String.fromCodePoint(cp));
      if (bytes+n>LIMIT) { add(w,i); w=i; bytes=0; }
      bytes+=n; i+=width;
      if (i===end) add(w,i);
    }
  }
  return [...(full ? [full] : []),...found.sort((a,b)=>b.rank-a.rank || a.start-b.start || b.end-a.end).slice(0,full ? 7 : 8).map(({rank,...p})=>p)];
}
function fields(raw,harness,role) {
  let content,prefix;
  if (harness==='codex' && raw.type==='response_item' && raw.payload?.type==='message' && raw.payload.role===role && ['user','assistant'].includes(role)) {
    content=raw.payload.content; prefix='payload.content';
  } else if (harness==='dsh' && raw.type===`${role}/message` && ['user','assistant'].includes(role)) {
    const data=raw.data;
    if (!data || typeof data!=='object' || (data.role && data.role!==role)) return [];
    if (data.message && typeof data.message==='object' && !Array.isArray(data.message)) {
      if (data.message.role && data.message.role!==role) return [];
      if (typeof data.message.content==='string'||Array.isArray(data.message.content)) {content=data.message.content;prefix='data.message.content';}
      else {content=data.message.text;prefix='data.message.text';}
    } else if (typeof data.content==='string'||Array.isArray(data.content)) {content=data.content;prefix='data.content';}
    else if (typeof data.text==='string') {content=data.text;prefix='data.text';}
    else {content=data.message;prefix='data.message';}
  } else return [];
  if (typeof content==='string') return [{path:prefix,text:content}];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part,i)=>{
    if (typeof part==='string') return [{path:`${prefix}.${i}`,text:part}];
    if (typeof part?.text==='string' && (!part.type || ['input_text','output_text','text'].includes(part.type))) return [{path:`${prefix}.${i}.text`,text:part.text}];
    return [];
  });
}
function projectOriginal(row,choices,originalSha256,raw) {
  const rawFields=fields(raw,row.source?.harness,row.item.role), result=[];
  for (const choice of choices) {
    if (!choice || !['full','fragment','relay-input'].includes(choice.kind) || typeof choice.text!=='string' || !choice.text || Buffer.byteLength(choice.text)>LIMIT || !Number.isInteger(choice.start) || !Number.isInteger(choice.end) || row.item.text?.slice(choice.start,choice.end)!==choice.text) continue;
    const previewRange=visible(row.item.text);
    if (!previewRange || choice.start<previewRange.start || choice.end>previewRange.end || (choice.kind==='relay-input') !== (previewRange.kind==='relay-input')) continue;
    const matches=[];
    for (const field of rawFields) {
      const area=visible(field.text);
      if (!area || matches.length >= 2 || (choice.kind==='relay-input') !== (area.kind==='relay-input')) continue;
      let at=field.text.indexOf(choice.text,area.start);
      while (matches.length < 2 && at!==-1 && at+choice.text.length<=area.end) {
        matches.push({field,at});
        at=field.text.indexOf(choice.text,at+1);
      }
    }
    if (matches.length!==1) continue;
    const {field,at}=matches[0], end=at+choice.text.length;
    const kind = choice.kind === 'full' && (rawFields.length !== 1 || at !== 0 || end !== field.text.length)
      ? 'fragment' : choice.kind;
    result.push({...choice,kind,projection:{kind,fieldPath:field.path,originalSha256,startUtf16:at,endUtf16:end,startUtf8:Buffer.byteLength(field.text.slice(0,at)),endUtf8:Buffer.byteLength(field.text.slice(0,end)),previewStartUtf16:choice.start,previewEndUtf16:choice.end}});
  }
  return result;
}
async function inspectDraftEvidence(dir,row,choices) {
  if (!row?.item || !Array.isArray(choices)) return {status:'unknown',projections:[]};
  const original=await readVerifiedOriginal(dir,row.item.metadata?.original);
  if (original.status!=='verified') return {status:original.status,projections:[]};
  let raw;
  try { raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(original.bytes)); }
  catch { return {status:'integrity-failed',projections:[]}; }
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) return {status:'integrity-failed',projections:[]};
  return {status:'verified',projections:projectOriginal(row,choices,original.sha256,raw)};
}

async function verifiedProjections(dir,row,choices) {
  return (await inspectDraftEvidence(dir,row,choices)).projections;
}
// V2 preview check is independent of the local selector's ranked windows.
function previewDeclaredProjection(row,p) {
  const preview=row?.item?.text,role=row?.item?.role,type=row?.item?.metadata?.recordType,harness=row?.source?.harness;
  if(row?.item?.kind!=='message'||!['user','assistant'].includes(role)||!['codex','dsh'].includes(harness)||typeof preview!=='string'||Buffer.byteLength(preview)>MAX_INPUT)return null;
  if(type!==undefined && (typeof type!=='string' || !(type==='response_item:message'||type===role+'/message'||type.startsWith(role+'/message:'))))return null;
  const {previewStartUtf16:a,previewEndUtf16:b}=p,range=visible(preview),cuts=pos=>pos>0&&pos<preview.length&&/[\uD800-\uDBFF]/u.test(preview[pos-1])&&/[\uDC00-\uDFFF]/u.test(preview[pos]);
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||!range||a<range.start||b>a&&b>range.end||b<=a||cuts(a)||cuts(b)||(p.kind==='relay-input')!==(range.kind==='relay-input'))return null;
  const text=preview.slice(a,b);return require('./local-derive-selection.cjs').scrub(text)===text?text:null;
}
// V2 uses an explicitly declared preview/raw span, not the local selector's ranked windows.
async function verifyDeclaredProjection(dir,row,p) {
  const safePreview=previewDeclaredProjection(row,p);if(!safePreview)return {status:'integrity-failed'};
  const original=await readVerifiedOriginal(dir,row?.item?.metadata?.original);
  if(original.status!=='verified')return {status:original.status};
  try {
    const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(original.bytes));
    const preview=row.item.text, field=fields(raw,row.source?.harness,row.item.role).find(x=>x.path===p.fieldPath);
    if(typeof preview!=='string'||!field||original.sha256!==p.originalSha256)return {status:'integrity-failed'};
    const cuts=(text,pos)=>pos>0&&pos<text.length&&/[\uD800-\uDBFF]/u.test(text[pos-1])&&/[\uDC00-\uDFFF]/u.test(text[pos]);
    const {startUtf16:a,endUtf16:b,startUtf8:c,endUtf8:d,previewStartUtf16:e,previewEndUtf16:f}=p;
    if(![a,b,c,d,e,f].every(Number.isSafeInteger)||a<0||b<=a||b>field.text.length||e<0||f<=e||f>preview.length||cuts(field.text,a)||cuts(field.text,b)||cuts(preview,e)||cuts(preview,f))return {status:'integrity-failed'};
    const text=preview.slice(e,f),rawText=field.text.slice(a,b),vr=visible(preview),rr=visible(field.text);
    if(!vr||!rr||e<vr.start||f>vr.end||a<rr.start||b>rr.end||text!==safePreview||text!==rawText||p.kind==='relay-input'!==(vr.kind==='relay-input')||p.kind==='relay-input'!==(rr.kind==='relay-input')||require('./local-derive-selection.cjs').scrub(text)!==text||Buffer.byteLength(field.text.slice(0,a))!==c||Buffer.byteLength(field.text.slice(0,b))!==d)return {status:'integrity-failed'};
    return {status:'verified',text};
  }catch{return {status:'integrity-failed'}}
}
module.exports={previewProjections,verifiedProjections,inspectDraftEvidence,verifyDeclaredProjection,previewDeclaredProjection};
