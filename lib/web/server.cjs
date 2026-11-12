'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
const {createQuery} = require('../query.cjs');
const {graphWikiView} = require('../generated/graph-wiki-view.cjs');

const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="theme-color" content="#22334a"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/app-192.png"><link rel="stylesheet" href="/assets/vis.css"><link rel="stylesheet" href="/graph-wiki.css"><title>记忆查找</title></head><body><main><h1>记忆查找</h1><nav aria-label="入口"><button id="project-entry" type="button">项目工作页</button> <button id="topic-entry" type="button">知识主题页</button></nav><p id="entry-label">项目工作页</p><section id="project-overview"><h2>项目概览</h2><p>当前决定与未完任务</p><div id="project-decisions"></div><div id="project-tasks"></div></section><section id="topic-intro" hidden><h2>知识主题</h2><p>搜索并选择话题，查看关系、时间线和来源。</p></section><p>本地档案；结果仅覆盖当前项目已导入的记录。原文仅在点击证据后读取。</p><form id="search"><label>关键词 <input name="keyword"></label> <label>从 <input name="from" type="date"></label> <label>到 <input name="to" type="date"></label> <button>查找</button></form><p id="search-timezone"></p><div id="status" role="status"></div><p id="connection"></p><button id="cache-save" type="button">保存当前已审核摘要供离线查看</button> <button id="cache-clear" type="button">清除离线摘要</button><pre id="offline-list"></pre><section><h2>话题</h2><div id="topics"></div></section><p id="selected-topic" aria-live="polite"></p><section><h2>当前决定</h2><div id="current"></div></section><section><h2>局部关系图</h2><p>图和可视时间线显示当前可判断的状态；历史列表保留原评审标注。时间采用生效时间，缺失时使用来源时间。关系仅来自明确变更；点击节点查看来源。</p><p id="graph-coverage"></p><div id="graph" aria-label="局部关系图"></div></section><section><h2>可视化时间线</h2><p>没有时间的记录列在下方文本时间线中。</p><div id="visual-timeline" aria-label="可视化时间线"></div></section><section><h2>审核历史</h2><p>按页显示所选话题的审核历史。</p><div id="timeline" data-testid="reviewed-timeline"></div><p id="reviewed-status" data-testid="reviewed-timeline-status" role="status"></p><button id="reviewed-more" data-testid="reviewed-timeline-load-more" type="button" hidden>加载更多审核历史</button></section><section><h2>来源记录</h2><p>此列表按来源记录的话题筛选并按存储顺序排列。跨话题审核引用的来源可能不在此列表中，可从审核历史打开。</p><div id="source-history"></div><button id="source-more" type="button" hidden>加载更多来源</button></section><section><h2>证据</h2><pre id="evidence"></pre><form id="annotation"><label>批注类型 <select name="kind"><option value="annotation">批注</option><option value="correction">纠正解释</option><option value="decision">确认决定</option><option value="change">改变决定</option><option value="todo">待办</option></select></label><label>内容 <textarea name="text" required></textarea></label><label>话题（可选）<input name="topic"></label><label>指向的审核编号（改变决定和纠正解释时必填）<input name="revises"></label><label>生效时间（纠正立即生效；其他类型可选，RFC3339）<input name="valid_time" placeholder="2026-01-01T12:00:00Z"></label><label>决定依据<select name="basis"><option value="confirmed">已确定</option><option value="proposed">待决定</option><option value="uncertain">待核实</option></select></label><label>决定生命周期<select name="lifecycle"><option value="active">有效</option><option value="superseded">已替代</option><option value="cancelled">已取消</option></select></label><button>提交批注</button> <button id="draft-save" type="button">保存本地草稿</button> <button id="draft-retry" type="button">重试本地草稿</button> <button id="draft-delete" type="button">删除本地草稿</button></form><p id="draft-status">草稿仅保存在此浏览器；页面打开后可离线编辑。离线时无法读取档案。</p><div id="notes"></div></section></main><script src="/assets/cytoscape.js"></script><script src="/assets/vis.js"></script><script src="/graph-wiki.js"></script><script src="/app.js"></script></body></html>`;
const script = `let token = document.querySelector('meta[name=csrf]')?.content || '';
const activeScope = document.querySelector('meta[name=scope]').content;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const status = document.querySelector('#status'), topics = document.querySelector('#topics'), timeline = document.querySelector('#timeline'), evidence = document.querySelector('#evidence');
document.querySelector('#search-timezone').textContent = '日期按浏览器本地时区：' + (Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区');
function localDayBoundary(value, end) { const [y,m,d] = value.split('-').map(Number); const date = new Date(0); date.setFullYear(y,m-1,d); date.setHours(0,0,0,0); if (date.getFullYear() !== y || date.getMonth() !== m-1 || date.getDate() !== d) throw new Error('无效日期'); if (end) { date.setDate(date.getDate()+1); date.setHours(0,0,0,0); return date.toISOString(); } return date.toISOString(); }
async function api(path, options) { const r = await fetch(path, options); if (!r.ok) throw new Error(await r.text()); return r.json(); }
function button(label, action) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => action().catch(e => status.textContent = e.message); return b; }
let params = '', selected = null, reviewed = [], selectionGeneration = 0, evidenceGeneration = 0;
graphWiki.setup(e => status.textContent = e instanceof Error ? e.message : String(e), openEvidence);
async function openEvidence(citation) {
  const selection = selectionGeneration, click = ++evidenceGeneration;
  const isCurrent = () => selection === selectionGeneration && click === evidenceGeneration;
  selected = null; evidence.textContent = ''; document.querySelector('#notes').textContent = '';
  try {
    const result = await api('/api/evidence?' + new URLSearchParams({citation:JSON.stringify(citation)}));
    if (!isCurrent()) return;
    evidence.textContent = JSON.stringify(result,null,2); selected = citation;
    try {
      const notes = await api('/api/annotations?' + new URLSearchParams({target:JSON.stringify(citation)}));
      if (!isCurrent()) return;
      document.querySelector('#notes').textContent = notes.map(n => n.kind + ': ' + n.text).join('\\n');
    } catch (error) { if (isCurrent()) document.querySelector('#notes').textContent = '批注加载失败，请重试查看证据'; }
  } catch (error) { if (isCurrent()) throw error; }
}

const cacheKey = 'memory-shortlist:' + activeScope, offlineList = document.querySelector('#offline-list'), connection = document.querySelector('#connection');
function showOffline() { connection.textContent = navigator.onLine ? '在线（仍需本地服务可用）' : '离线：仅本地摘要和草稿可用，档案不可用'; const data = localStorage.getItem(cacheKey); offlineList.textContent = data ? '本地摘要（保存时间，可能已过期）: ' + data : '没有离线摘要'; }
document.querySelector('#cache-save').onclick = () => { localStorage.setItem(cacheKey, JSON.stringify({savedAt:new Date().toISOString(),items:reviewed.slice(0,50)})); showOffline(); };
document.querySelector('#cache-clear').onclick = () => { localStorage.removeItem(cacheKey); showOffline(); };
window.addEventListener('online',showOffline); window.addEventListener('offline',showOffline); showOffline();
async function freshToken() { const state = await api('/api/session'); if (state.scope !== activeScope) throw new Error('项目范围已更改，请重新打开页面'); token = state.csrf; }

const kindInput = document.querySelector('#annotation [name=kind]'), effectiveInput = document.querySelector('#annotation [name=valid_time]');
function updateEffectiveInput() { effectiveInput.disabled = kindInput.value === 'correction'; if (effectiveInput.disabled) effectiveInput.value = ''; }
kindInput.addEventListener('change',updateEffectiveInput); updateEffectiveInput();
function draftFromForm(f) { const kind=f.get('kind'); return {id:crypto.randomUUID(),kind,text:f.get('text'),target:selected,topic:f.get('topic') || undefined,valid_time:kind === 'correction' ? undefined : (f.get('valid_time') || undefined),basis:f.get('basis'),lifecycle:f.get('lifecycle'),revises:['change','correction'].includes(kind) ? (f.get('revises') || undefined) : undefined}; }
const draftKey = 'memory-draft:' + document.querySelector('meta[name=scope]').content, draftStatus = document.querySelector('#draft-status');
function showDraft() { draftStatus.textContent = localStorage.getItem(draftKey) ? '本地草稿待提交；仅保存在此浏览器。' : '没有本地草稿；页面打开后可离线编辑，离线时无法读取档案。'; }
document.querySelector('#draft-save').onclick = () => { const f = new FormData(document.querySelector('#annotation')); if (!selected || !String(f.get('text')).trim()) { status.textContent = '请先选择证据并填写内容'; return; } localStorage.setItem(draftKey, JSON.stringify(draftFromForm(f))); showDraft(); };
document.querySelector('#draft-delete').onclick = () => { localStorage.removeItem(draftKey); showDraft(); };
document.querySelector('#draft-retry').onclick = async () => { const raw = localStorage.getItem(draftKey); if (!raw) return; try { await freshToken(); await api('/api/annotations',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:raw}); localStorage.removeItem(draftKey); showDraft(); status.textContent = '本地草稿已提交'; } catch (err) { status.textContent = '提交失败，草稿仍保存在本地'; } };
showDraft();
document.querySelector('#annotation').onsubmit = async e => { e.preventDefault(); if (!selected) { status.textContent = '请先查看证据'; return; } const f = new FormData(e.target); try { await freshToken(); await api('/api/annotations', {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify(draftFromForm(f))}); e.target.reset(); updateEffectiveInput(); status.textContent = '批注已保存；原始记录未更改'; } catch(err) { status.textContent = err.message; } };
let reviewedCursor = null, reviewedParams = '', reviewedLoading = false, reviewedNeedsRefresh = false;
const reviewedMore = document.querySelector('#reviewed-more'), reviewedStatus = document.querySelector('#reviewed-status');
async function loadReviewed(generation) {
  if (reviewedLoading) return;
  reviewedLoading = true; reviewedMore.disabled = true;
  try {
    const p = new URLSearchParams(reviewedParams); if (reviewedCursor) p.set('cursor',reviewedCursor);
    const response = await fetch('/api/reviewed-timeline-page?' + p);
    if (generation !== selectionGeneration) return;
    if (response.status === 409) {
      reviewedCursor = null; reviewedNeedsRefresh = true;
      reviewedStatus.textContent = '审核历史已更改，请重新加载。';
      reviewedMore.hidden = false; reviewedMore.textContent = '重新加载审核历史';
      return;
    }
    if (!response.ok) throw new Error(await response.text());
    const page = await response.json();
    if (generation !== selectionGeneration) return;
    for (const r of page.rows) {
      const item = document.createElement('div'), text = document.createElement('p');
      text.textContent = [r.time, r.label || r.kind, r.text, r.next_step && '下一步: ' + r.next_step, ...r.annotations.map(a => a.kind + ': ' + a.text)].filter(Boolean).join(' · ');
      item.append(text,button('查看证据',async () => { if (generation === selectionGeneration) await openEvidence(r.citation); }));
      timeline.append(item);
    }
    reviewed.push(...page.rows.filter(r => r.kind === 'todo').map(r => ({topic:r.topic,next_step:r.next_step})));
    reviewedCursor = page.nextCursor; reviewedMore.hidden = !reviewedCursor; reviewedMore.textContent = '加载更多审核历史';
    const filtered = p.has('from') || p.has('to');
    reviewedStatus.textContent = reviewedCursor ? '还有更多符合筛选条件的审核历史' : filtered ? '已到所选时间范围的审核历史末页' : '已到所选话题的审核历史末页';
  } catch (error) { if (generation === selectionGeneration) { reviewedMore.hidden = false; reviewedMore.textContent = '重试加载审核历史'; reviewedStatus.textContent = '加载失败，请重试。'; } throw error; }
  finally { if (generation === selectionGeneration) { reviewedLoading = false; reviewedMore.disabled = false; } }
}
reviewedMore.onclick = () => {
  const p = new URLSearchParams(reviewedParams);
  const action = reviewedNeedsRefresh
    ? selectTopic(p.get('topic'), reviewedParams, true)
    : loadReviewed(selectionGeneration);
  action.catch(e => status.textContent = e.message);
};
let sourceCursor = null, sourceParams = '';
const sourceHistory = document.querySelector('#source-history'), sourceMore = document.querySelector('#source-more');
async function loadSources(generation) {
  sourceMore.disabled = true;
  try {
    const p = new URLSearchParams(sourceParams); if (sourceCursor) p.set('cursor',sourceCursor);
    const page = await api('/api/topic-sources?' + p);
    if (generation !== selectionGeneration) return;
    for (const r of page.rows) {
      const item = document.createElement('div'), text = document.createElement('p');
      text.textContent = [r.time, r.text || r.kind].filter(Boolean).join(' · ');
      item.append(text,button('查看来源证据',async () => { if (generation === selectionGeneration) await openEvidence(r.citation); }));
      sourceHistory.append(item);
    }
    sourceCursor = page.nextCursor; sourceMore.hidden = !sourceCursor; sourceMore.textContent = '加载更多来源';
  } catch (error) { if (generation === selectionGeneration) { sourceMore.hidden = false; sourceMore.textContent = '重试加载来源'; } throw error; } finally { if (generation === selectionGeneration) sourceMore.disabled = false; }
}
sourceMore.onclick = () => loadSources(selectionGeneration).catch(e => status.textContent = e.message);
async function selectTopic(topic, searchParams, keepEvidence = false) {
  const generation = ++selectionGeneration;
  graphWiki.clearGraph();
  const p = new URLSearchParams(searchParams); p.set('topic',topic); p.delete('keyword');
  document.querySelector('#selected-topic').textContent = '当前话题：' + topic;
  document.querySelector('#current').textContent = '';
  timeline.replaceChildren(); reviewedCursor = null; reviewedParams = p.toString(); reviewedLoading = false; reviewedNeedsRefresh = false; reviewedMore.disabled = false; reviewedMore.hidden = true; reviewedStatus.textContent = ''; sourceHistory.replaceChildren(); sourceMore.hidden = true; sourceCursor = null; sourceParams = p.toString(); reviewed = [];
  if (!keepEvidence) { evidence.textContent = ''; document.querySelector('#notes').textContent = ''; selected = null; }
  const current = await api('/api/current?' + new URLSearchParams({topic}));
  if (generation !== selectionGeneration) return;
  document.querySelector('#current').textContent = current.map(c => [c.label,c.text || c.reason,c.review_id && '审核编号: ' + c.review_id,...(c.pending || []).map(p => '待处理: ' + p.label + ' ' + p.text)].filter(Boolean).join(' · ')).join(' | ');
  reviewed = current.map(c => ({topic:c.topic,label:c.label,text:c.text || c.reason}));
  await Promise.all([graphWiki.showGraph(p.toString(),openEvidence,e => status.textContent = e instanceof Error ? e.message : String(e), () => generation === selectionGeneration), loadSources(generation), loadReviewed(generation)]);
}
document.querySelector('#search').onsubmit = async e => {
  e.preventDefault(); const generation = ++selectionGeneration; graphWiki.clearGraph(); reviewedMore.hidden = true; reviewedStatus.textContent = ''; selected = null; evidence.textContent = ''; document.querySelector('#notes').textContent = '';
  const f = new FormData(e.target), p = new URLSearchParams();
  for (const [k,v] of f) if (v) p.set(k,k === 'to' ? localDayBoundary(v,true) : k === 'from' ? localDayBoundary(v,false) : v);
  if (p.has('to')) p.set('toExclusive','true'); params = p.toString();
  try {
    const result = await api('/api/find?' + params);
    if (generation !== selectionGeneration) return;
    topics.replaceChildren(); timeline.replaceChildren(); reviewedMore.hidden = true; reviewedStatus.textContent = ''; reviewedLoading = false; sourceHistory.replaceChildren(); sourceMore.hidden = true; evidence.textContent = ''; selected = null; reviewed = [];
    document.querySelector('#current').textContent = ''; document.querySelector('#selected-topic').textContent = '';
    for (const row of result.topics) {
      const d = document.createElement('div');
      d.append(button(row.topic + ' (' + row.count + ')', () => selectTopic(row.topic,params)));
      topics.append(d);
    }
    status.textContent = result.topics.length ? '' : '没有找到匹配话题';
  } catch(err) { if (generation === selectionGeneration) status.textContent = err.message; }
};
`;
const serviceWorker = `const CACHE = 'memory-shell-v3';
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/offline-shell','/app.js','/assets/cytoscape.js','/assets/vis.js','/assets/vis.css','/graph-wiki.css','/graph-wiki.js','/manifest.webmanifest','/icons/app-192.png','/icons/app-512.png'])).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { const u = new URL(e.request.url); if (u.origin !== self.location.origin || e.request.method !== 'GET') return; const key = e.request.mode === 'navigate' ? '/offline-shell' : ['/app.js','/assets/cytoscape.js','/assets/vis.js','/assets/vis.css','/graph-wiki.css','/graph-wiki.js','/manifest.webmanifest','/icons/app-192.png','/icons/app-512.png'].includes(u.pathname) ? e.request : null; if (!key) return; e.respondWith(fetch(e.request).then(async r => { if ([502,503,504].includes(r.status)) return (await caches.match(key)) || r; return r; }).catch(() => caches.match(key))); });`;
function createWebServer({archive, owner, project, host = '127.0.0.1', port = 0, externalOrigin, allowedTailnetUser}) {
  if (host !== '127.0.0.1') throw new Error('Only IPv4 loopback is supported');
  if (!owner || !project) throw new Error('owner and project are required');
  const remote = externalOrigin !== undefined || allowedTailnetUser !== undefined;
  let external;
  if (remote) {
    if (typeof externalOrigin !== 'string' || typeof allowedTailnetUser !== 'string' || !allowedTailnetUser.trim() || allowedTailnetUser !== allowedTailnetUser.trim() || /[\x00-\x1f\x7f]/.test(allowedTailnetUser)) throw new Error('External mode requires an HTTPS origin and one Tailscale user');
    try { external = new URL(externalOrigin); } catch { throw new Error('Invalid external origin'); }
    if (external.protocol !== 'https:' || external.origin !== externalOrigin || external.username || external.password || external.pathname !== '/' || external.search || external.hash) throw new Error('External origin must be an exact HTTPS origin');
  }
  const query = createQuery(archive), csrf = crypto.randomBytes(32).toString('hex');
  const scopeKey = crypto.createHash('sha256').update(JSON.stringify([archive.dir || null,owner,project])).digest('hex');
  const server = http.createServer(async (req,res) => {
    const address = server.address();
    const authority = `127.0.0.1:${address && address.port}`;
    const origin = remote ? external.origin : `http://${authority}`;
    const expectedHost = remote ? external.host : authority;
    const headers = {'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; manifest-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
    function send(code, body, type='application/json; charset=utf-8') { res.writeHead(code,{...headers,'Content-Type':type}); res.end(body); }
    try {
      const count = name => req.rawHeaders.filter((_,index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
      if (count('host') !== 1 || count('origin') > 1 || (remote && (count('tailscale-user-login') !== 1 || req.headers['tailscale-user-login'] !== allowedTailnetUser)) || req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== origin)) return send(403,'Forbidden','text/plain');
      const url = new URL(req.url, origin), args = {owner,project};
      for (const k of ['keyword','from','to','topic']) if (url.searchParams.has(k)) args[k] = url.searchParams.get(k);
      if (url.searchParams.get('toExclusive') === 'true') args.toExclusive = true;
      if (req.method === 'GET' && url.pathname === '/') return send(200,page.replace('<head>',`<head><meta name="csrf" content="${csrf}"><meta name="scope" content="${scopeKey}">`),'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/offline-shell') return send(200,page.replace('<head>',`<head><meta name="scope" content="${scopeKey}">`),'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/sw.js') return send(200,serviceWorker,'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/session') return send(200,JSON.stringify({scope:scopeKey,csrf}));
      if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') return send(200,JSON.stringify({id:'/',name:'记忆查找',short_name:'记忆',start_url:'/',scope:'/',display:'standalone',background_color:'#f5f7fa',theme_color:'#22334a',icons:[{src:'/icons/app-192.png',sizes:'192x192',type:'image/png'},{src:'/icons/app-512.png',sizes:'512x512',type:'image/png'}]}),'application/manifest+json; charset=utf-8');
      if (req.method === 'GET' && ['/icons/app-192.png','/icons/app-512.png'].includes(url.pathname)) return send(200,await readFile(path.join(__dirname,url.pathname.slice(1))),'image/png');
      const assets = {'/assets/cytoscape.js':[path.join(path.dirname(require.resolve('cytoscape')),'cytoscape.min.js'),'text/javascript; charset=utf-8'], '/assets/vis.js':[path.join(path.dirname(require.resolve('vis-timeline/package.json')),'standalone/umd/vis-timeline-graph2d.min.js'),'text/javascript; charset=utf-8'], '/assets/vis.css':[path.join(path.dirname(require.resolve('vis-timeline/package.json')),'styles/vis-timeline-graph2d.min.css'),'text/css; charset=utf-8']};
      if (req.method === 'GET' && assets[url.pathname]) return send(200,await readFile(assets[url.pathname][0]),assets[url.pathname][1]);
      if (req.method === 'GET' && url.pathname === '/graph-wiki.css') return send(200,'#graph {height:320px;border:1px solid #aaa} #visual-timeline {min-height:220px} nav {margin:1em 0} pre {white-space:pre-wrap;overflow-wrap:anywhere} .vis-item.status-confirmed {background:#d7eddd;border-color:#277852} .vis-item.status-proposed {background:#fff0c9;border-color:#ac6a00} .vis-item.status-uncertain {background:#f9d9d5;border-color:#9d4a44} .vis-item.status-superseded {background:#e2e6e9;border-color:#697785} .vis-item.status-cancelled {background:#efdce8;border-color:#773f64} .vis-item.status-task {background:#dcecff;border-color:#346ba0} .vis-item.status-completed {background:#dceee0;border-color:#56866a}','text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/graph') {
        if (!args.topic) return send(400,'Topic required','text/plain');
        const {all,filtered,current}=await query.reviewedGraph(args);
        return send(200,JSON.stringify(graphWikiView(all,current,filtered)));
      }
      if (req.method === 'GET' && url.pathname === '/graph-wiki.js') return send(200,'{ const exports = {};\n' + await readFile(path.join(__dirname,'../generated/graph-wiki-browser.cjs'),'utf8') + '\n}','text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.js') return send(200,script,'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/find') return send(200,JSON.stringify(await query.find(args)));
      if (req.method === 'GET' && url.pathname === '/api/tasks') return send(200,JSON.stringify(await query.taskList(args)));
      if (req.method === 'GET' && url.pathname === '/api/current') return send(200,JSON.stringify(await query.current(args)));
      if (req.method === 'GET' && url.pathname === '/api/topic-sources') { if (!args.topic) return send(400,'Topic required','text/plain'); if (url.searchParams.has('cursor')) args.cursor = url.searchParams.get('cursor'); return send(200,JSON.stringify(await query.topicSources(args))); }
      if (req.method === 'GET' && url.pathname === '/api/reviewed-timeline-page') {
        if (!args.topic) return send(400,'Topic required','text/plain');
        if (url.searchParams.has('cursor')) args.cursor = url.searchParams.get('cursor');
        if (url.searchParams.has('limit')) { const value = url.searchParams.get('limit'); if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) return send(400,'Invalid limit','text/plain'); args.limit = Number(value); }
        try { return send(200,JSON.stringify(await query.reviewedTimelinePage(args))); }
        catch (err) { if (err.message === 'reviewed timeline cursor is stale') return send(409,'reviewed timeline cursor is stale','text/plain'); throw err; }
      }
      if (req.method === 'GET' && url.pathname === '/api/reviewed-timeline') { if (!args.topic) return send(400,'Topic required','text/plain'); return send(200,JSON.stringify(await query.reviewedTimeline(args))); }
      if (req.method === 'GET' && url.pathname === '/api/timeline') return send(200,JSON.stringify(await query.timeline(args)));
      if (req.method === 'GET' && url.pathname === '/api/evidence') { const c = JSON.parse(url.searchParams.get('citation') || '{}'); return send(200,JSON.stringify(await query.evidence({id:c.id,revision:c.revision,source:c.source,...args}))); }
      if (req.method === 'GET' && url.pathname === '/api/annotations') { const target = url.searchParams.get('target'); return send(200,JSON.stringify(await query.annotations({...args,...(target ? {target:JSON.parse(target)} : {})}))); }
      if (req.method === 'POST' && url.pathname === '/api/annotations') {
        if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== csrf || !String(req.headers['content-type'] || '').startsWith('application/json')) return send(403,'Forbidden','text/plain');
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) return send(413,'Too large','text/plain'); }
        const input = JSON.parse(body);
        if (!['annotation','correction','decision','change','todo'].includes(input.kind) || typeof input.text !== 'string' || !input.text.trim() || !input.target) return send(400,'Invalid annotation','text/plain');
        if (input.basis !== undefined && !['confirmed','proposed','uncertain'].includes(input.basis)) return send(400,'Invalid basis','text/plain');
        if (input.lifecycle !== undefined && !['active','superseded','cancelled'].includes(input.lifecycle)) return send(400,'Invalid lifecycle','text/plain');
        if (input.kind === 'correction' && Object.hasOwn(input,'valid_time')) return send(400,'Corrections take effect immediately and cannot have valid_time','text/plain');
        if (input.valid_time !== undefined && (typeof input.valid_time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.valid_time) || !Number.isFinite(Date.parse(input.valid_time)))) return send(400,'Invalid effective time','text/plain');
        if (input.topic !== undefined && (typeof input.topic !== 'string' || input.topic.length > 256)) return send(400,'Invalid topic','text/plain');
        if (input.revises !== undefined && (typeof input.revises !== 'string' || !input.revises.trim())) return send(400,'Invalid revisions','text/plain');
        if (['change','correction'].includes(input.kind) && !input.revises) return send(400,'Change needs a revision target','text/plain');
        await query.evidence({id:input.target.id,revision:input.target.revision,source:input.target.source,...args});
        if (input.id !== undefined && (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id))) return send(400,'Invalid ID','text/plain');
        return send(201,JSON.stringify(await query.annotate({...args,id:input.id || crypto.randomUUID(),kind:input.kind,text:input.text,target:input.target,...(input.topic ? {topic:input.topic} : {}),...(input.valid_time ? {valid_time:input.valid_time} : {}),...(input.basis ? {basis:input.basis} : {}),...(input.lifecycle ? {lifecycle:input.lifecycle} : {}),...(input.revises ? {revises:input.revises} : {})})));
      }
      send(404,'Not found','text/plain');
    } catch (err) { send(400,'Invalid request','text/plain'); }
  });
  return {server, listen:() => new Promise((resolve,reject) => {server.once('error',reject); server.listen(port,host,() => resolve(server.address()));}), close:() => new Promise((resolve,reject) => server.close(e => e ? reject(e) : resolve()))};
}
module.exports = {createWebServer};
