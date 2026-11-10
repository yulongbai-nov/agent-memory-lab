'use strict';

// Versioned, read-only readers for local JSONL session exports. Private source
// formats can change; unrecognized records remain represented as metadata.
const fs = require('node:fs');
const readline = require('node:readline');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const VERSION = 'local-jsonl-v2';
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const key = (prefix, value) => `${prefix}:${hash(value).slice(0, 32)}`;
function scrub(value) {
  return String(value)
    .replace(/\b(?:sk|api|token|secret|key)[-_][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/\b(password|passwd|token|api[_-]?key|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\Users\\)[^\s"']+/g, '[PRIVATE_PATH]');
}
function contentText(value) {
  if (typeof value === 'string') return scrub(value);
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap(part => typeof part === 'string' ? [part] : part && typeof part.text === 'string' ? [part.text] : []);
  return parts.length ? scrub(parts.join('\n')) : undefined;
}
function sourceIdentity({ harness, instance, session }) {
  return { harness, instance: key('instance-v1', instance), session: key('session-v1', session) };
}
function normalize(record, line, harness, identity, observedAt, activeTurn) {
  const envelope = record.payload && typeof record.payload === 'object' ? record.payload : record.data && typeof record.data === 'object' ? record.data : record;
  const payload = envelope.message && typeof envelope.message === 'object' ? { ...envelope, ...envelope.message } : envelope;
  const type = String(payload.type || record.type || 'unknown');
  const recordType = String(record.type || type);
  const nativeId = payload.id || payload.call_id || payload.callId || record.id;
  const id = nativeId ? key('native-v1', `${identity}:${recordType}:${type}:${nativeId}`) : key('coordinate-v1', `${identity}:${line}`);
  const role = ['user', 'assistant', 'system', 'developer', 'tool'].includes(payload.role) ? payload.role : undefined;
  let kind = 'event';
  if (type === 'message' || role) kind = 'message';
  else if (/compac|compress|summary/i.test(type)) kind = 'compression';
  else if (/function_call_output|tool[\/_.-]result|tool_result/i.test(type)) kind = 'tool_result';
  else if (/function_call|tool[\/_.-]call|tool_call/i.test(type)) kind = 'tool_call';
  else if (/attachment/i.test(type)) kind = 'attachment';
  const rawText = payload.content ?? payload.text ?? payload.output ?? payload.arguments ?? payload.reason ?? (typeof envelope.message === 'string' ? envelope.message : undefined);
  const text = contentText(rawText);
  const turn = payload.turn_id ?? payload.turnId ?? payload.turn?.id ?? (typeof payload.turn === 'string' || typeof payload.turn === 'number' ? payload.turn : undefined) ?? record.turn_id ?? record.turnId ?? activeTurn;
  let status;
  if (/turn[\/_.-](?:end|completed)|item[\/_.-]completed|task_complete/i.test(recordType + ' ' + type)) status = /interrupt|cancel/i.test(String(payload.reason || '')) ? 'interrupted' : /fail|error/i.test(String(payload.reason || '')) ? 'failed' : 'completed';
  else if (/fail|error/i.test(type)) status = 'failed';
  else if (/interrupt|cancel/i.test(type)) status = 'interrupted';
  else if (['completed', 'failed', 'interrupted', 'in_progress'].includes(payload.status)) status = payload.status;
  const item = { id, kind, observedAt, metadata: { adapterVersion: VERSION, recordType: scrub(recordType + (type !== recordType ? ':' + type : '')).slice(0, 100), coordinate: line, idBasis: nativeId ? 'native-unverified' : 'line-coordinate-unverified', locator: 'unavailable' } };
  if (turn != null) item.turnId = key('turn-v1', turn);
  if (role) item.role = role;
  if (text !== undefined) item.text = text;
  if (typeof record.time === 'string') item.time = scrub(record.time);
  else if (typeof record.timestamp === 'string') item.time = scrub(record.timestamp);
  else if (typeof payload.timestamp === 'string') item.time = scrub(payload.timestamp);
  if (status) item.status = status;
  // Observation time and retry context do not participate in revision identity.
  item.revision = `sha256:${hash(JSON.stringify([VERSION, harness, item.id, item.kind, item.role, item.text, item.time, item.status, item.turnId, item.metadata.recordType]))}`;
  return item;
}
async function* read(harness, opts) {
  if (!opts || !opts.file || !opts.owner || !opts.project || !opts.instance || !opts.session) throw new TypeError('file, owner, project, instance and session are required');
  const bounded = (value, fallback, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
  const lookback = bounded(opts.lookback, 50, 10000);
  const maxRecords = Math.max(1, bounded(opts.maxRecords, 10000, 100000));
  const batchSize = Math.max(1, bounded(opts.batchSize, 100, 1000));
  const previous = bounded(opts.checkpoint?.position, 0, Number.MAX_SAFE_INTEGER);
  const priorGaps = Array.isArray(opts.checkpoint?.source?.coverage?.gaps) ? opts.checkpoint.source.coverage.gaps : [];
  const persistent = priorGaps.filter(g => !['scan-limit','partial-tail','outside-scan'].includes(g.reason));
  const repairBudget = maxRecords === 1 ? (opts.checkpoint?.source?.coverage?.repairOnly ? 0 : 1) : Math.floor(maxRecords / 2);
  const repairCandidates = [...new Set(persistent.filter(g => g.reason === 'invalid-json' && Number.isSafeInteger(g.coordinate) && g.coordinate > 0).map(g => g.coordinate))].sort((a,b) => a-b);
  const cursor = Number.isSafeInteger(opts.checkpoint?.source?.coverage?.repairCursor) ? opts.checkpoint.source.coverage.repairCursor : 0;
  const split = repairCandidates.findIndex(n => n > cursor);
  const orderedRepairs = split < 0 ? repairCandidates : repairCandidates.slice(split).concat(repairCandidates.slice(0, split));
  const selectedRepairs = orderedRepairs.slice(0, Math.min(1, repairBudget));
  const repairs = new Set(selectedRepairs);
  const forwardBudget = maxRecords - repairs.size;
  const start = Math.max(0, previous - Math.min(lookback, Math.max(0, forwardBudget - 1)));
  const source = { ...sourceIdentity({ harness, instance: opts.instance, session: opts.session }), coverage: { from: start + 1, gaps: persistent.map(g => ({...g})), complete: false, repairOnly: forwardBudget === 0, repairCursor: cursor } };
  const addGap = gap => { if (!source.coverage.gaps.some(g => JSON.stringify(g) === JSON.stringify(gap))) source.coverage.gaps.push(gap); };
  const clearRepaired = coordinate => { source.coverage.gaps = source.coverage.gaps.filter(g => !(g.reason === 'invalid-json' && g.coordinate === coordinate)); };
  if (opts.parent) source.parent = key('session-v1', opts.parent);
  if (opts.forkBoundary != null) source.forkBoundary = key('boundary-v1', opts.forkBoundary);
  const scope = { owner: opts.owner, project: opts.project };
  // readline accepts a final unterminated line, but a live writer may still be
  // appending it. Check the last byte and withhold that line until a later scan.
  const stat = await fs.promises.stat(opts.file);
  let terminated = true;
  if (!opts.file.endsWith('.zstd') && !opts.file.endsWith('.zst') && stat.size) {
    const handle = await fs.promises.open(opts.file, 'r');
    try { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, stat.size - 1); terminated = byte[0] === 10; } finally { await handle.close(); }
  }
  const stream = fs.createReadStream(opts.file);
  const input = opts.file.endsWith('.zstd') || opts.file.endsWith('.zst') ? stream.pipe(zlib.createZstdDecompress()) : stream;
  if (input !== stream) stream.on('error', error => input.destroy(error));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let line = 0, scanned = 0, items = [], pending, batchPrevious = opts.checkpoint ? previous : null, truncated = false, activeTurn, lastSeq;
  const parse = (current, coordinate) => {
    const record = JSON.parse(current);
    if (harness === 'dsh' && Number.isSafeInteger(record.seq)) {
      if (lastSeq !== undefined && record.seq > lastSeq + 1 && coordinate > start) addGap({ from: lastSeq + 1, to: record.seq - 1, reason: 'source-sequence-gap' });
      lastSeq = record.seq;
    }
    const data = record.payload || record.data || {};
    const type = String(data.type || record.type || '');
    const turn = data.turn_id ?? data.turnId ?? data.turn?.id ?? (typeof data.turn === 'string' || typeof data.turn === 'number' ? data.turn : undefined);
    if (turn != null && /turn|task|start/i.test(type + ' ' + record.type)) activeTurn = turn;
    const item = normalize(record, coordinate, harness, `${opts.instance}:${opts.session}`, new Date().toISOString(), activeTurn);
    if (/turn[\/_.-](?:end|completed)|task_complete/i.test(type + ' ' + record.type)) activeTurn = undefined;
    return item;
  };
  const emit = position => ({ scope, source: { ...source, coverage: { ...source.coverage, gaps: [...source.coverage.gaps], to: position } }, checkpoint: { previous: batchPrevious, position }, items });
  try {
    for await (const next of lines) {
      // Delay one line so an incomplete tail cannot be committed.
      if (pending === undefined) { pending = next; continue; }
      line++; const current = pending; pending = next;
      if (line <= start) {
        try { const item = parse(current, line); if (repairs.has(line)) { items.push(item); clearRepaired(line); source.coverage.repairCursor = line; } }
        catch { if (repairs.has(line)) { addGap({coordinate:line,reason:'invalid-json'}); source.coverage.repairCursor = line; } }
        if (items.length >= batchSize) { yield emit(previous); batchPrevious = previous; items = []; }
        continue;
      }
      if (scanned >= forwardBudget) { truncated = true; break; }
      scanned++;
      if (repairs.has(line)) source.coverage.repairCursor = line;
      try { items.push(parse(current, line)); clearRepaired(line); }
      catch { addGap({ coordinate: line, reason: 'invalid-json' }); }
      if (items.length >= batchSize) { yield emit(Math.max(previous, line)); batchPrevious = Math.max(previous, line); items = []; }
    }
    if (!truncated && pending !== undefined && terminated) {
      line++;
      if (line > start) {
        if (scanned < forwardBudget) {
          if (repairs.has(line)) source.coverage.repairCursor = line;
          try { items.push(parse(pending, line)); clearRepaired(line); }
          catch { addGap({ coordinate: line, reason: 'invalid-json' }); }
        } else truncated = true;
      }
    }
    if (!terminated && !truncated) addGap({ coordinate: line + 1, reason: 'partial-tail' });
    if (line < previous && !truncated) addGap({ from: line + 1, to: previous, reason: 'source-truncated-or-changed' });
    source.coverage.complete = !truncated && terminated && start === 0 && source.coverage.gaps.length === 0;
    source.coverage.priorRangeUnverified = start > 0;
    if (truncated) addGap({ coordinate: line + 1, reason: 'scan-limit' });
    // Even an empty batch communicates the coverage and a safe resume point.
    yield emit(Math.max(previous, batchPrevious ?? 0, Math.min(line, start + forwardBudget)));
  } finally { lines.close(); input.destroy(); if (input !== stream) stream.destroy(); }
}
const readCodex = opts => read('codex', opts);
const readDsh = opts => read('dsh', opts);
module.exports = { readCodex, readDsh, sourceIdentity, VERSION };
