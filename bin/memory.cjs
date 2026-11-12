#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const options = Object.fromEntries([
  'split', 'dir', 'owner', 'project', 'keyword', 'from', 'to', 'limit', 'id', 'revision', 'format', 'receipt', 'receipt-sha256', 'expect-latest', 'review-id', 'primary',
  'source', 'file', 'instance', 'session', 'max-records', 'batch-size', 'port', 'first-coordinate', 'last-coordinate', 'expect-snapshot',
  'kind', 'text', 'manifest', 'target', 'evidence', 'task-root', 'parents', 'state', 'evidence-kind', 'occurred-at', 'topic', 'offset', 'couch-url', 'root', 'sync-mode', 'max-sessions', 'basis', 'lifecycle', 'revises', 'interval', 'runs', 'valid-time', 'serve-origin', 'serve-tailnet-user'
].map(name => [name, { type: 'string' }]));
options.synthetic = { type: 'boolean' };
options.recent = { type: 'boolean' };
options['local-draft'] = { type: 'boolean' };
options.preview = { type: 'boolean' };
options.help = { type: 'boolean', short: 'h' };
options['allow-annotations'] = { type: 'boolean' };

function usage() {
  console.log(`Usage: memory <command> --project PROJECT [--dir PRIVATE_DIRECTORY]
Commands:
  training-manifest --synthetic [--split train|test]
  training-eval-requests --synthetic
  training-eval-score --synthetic < PREDICTIONS_JSON
  ingest --source dsh|codex|chatgpt --file FILE --instance INSTANCE --session SESSION
         [--max-records N] [--batch-size N]
  ingest-tree --source dsh|codex --root DIRECTORY --instance INSTANCE [--max-sessions N] [--offset N]
  find [--keyword TEXT] [--from DATE] [--to DATE] [--limit N] [--preview]
  timeline --topic TOPIC [--from DATE] [--to DATE]
  current --topic TOPIC
  evidence --id ID --revision VERSION --source dsh|codex --instance INSTANCE --session SESSION
  verify-original --id ID --revision VERSION
  original-coverage --source dsh|codex --instance ARCHIVED_INSTANCE --session ARCHIVED_SESSION
                    --first-coordinate N --last-coordinate N [--expect-snapshot SHA256]
  repair-original --manifest PRIVATE_JSON --id ID --revision VERSION
  coverage
  migrate-index
  export-index
  annotate --target CITATION_JSON --kind note|correction|decision|change|todo --text TEXT [--id RETRY_ID] [--evidence CITATION_JSON]
  watch --manifest PRIVATE_JSON [--interval SECONDS] [--runs N]
  semantic-status
  task-list --dir PRIVATE_DIRECTORY --owner OWNER --project PROJECT
  draft-publish --dir PRIVATE_DIRECTORY --owner OWNER --project PROJECT --receipt FILE --receipt-sha256 HASH --expect-latest HASH|none
  draft-review --dir PRIVATE_DIRECTORY --owner OWNER --project PROJECT --id ID --text TEXT --topic TOPIC [--basis BASIS] [--primary 1|2|3]
  draft-review-show --dir PRIVATE_DIRECTORY --owner OWNER --project PROJECT --review-id ID
  draft-list --dir PRIVATE_DIRECTORY --owner OWNER --project PROJECT
  draft-show --dir PRIVATE_DIRECTORY --owner OWNER --project PROJECT --id CANDIDATE_ID
  daily [--manifest PRIVATE_JSON] [--local-draft]
  serve [--port PORT] [--serve-origin HTTPS_ORIGIN --serve-tailnet-user LOGIN]
  mcp [--allow-annotations]
  sync --couch-url URL [--sync-mode annotations|pull|all]
  provision-hub --couch-url URL
Run with --help for this overview.`);
}

function positiveInt(value, max) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('Invalid numeric option.');
  return n;
}

function nonnegativeInt(value,max) {
  if(value===undefined)return undefined;
  const n=Number(value);if(!Number.isSafeInteger(n)||n<0||n>max)throw new Error('Invalid numeric option.');return n;
}

async function ingest(op, options) {
  const { readCodex, readDsh, sourceIdentity } = require('../lib/adapters');
  const read = options.source === 'chatgpt' ? require('../lib/adapters/chatgpt-snapshot.cjs').readChatgptSnapshot : { codex: readCodex, dsh: readDsh }[options.source];
  if (!read || !options.file || !options.instance || !options.session) throw new Error('Provide a source, file, instance, and session.');
  const source = { ...op.scope, harness: options.source, instance: options.instance, session: options.session };
  const checkpoint = await op.archive.getCheckpoint({ ...op.scope, ...sourceIdentity(source) });
  const stats = { batches: 0, itemsImported: 0, batchesReplayed: 0 };
  const { originalCapture } = require('../lib/originals.cjs');
  for await (const batch of read({
    ...source, file: options.file, checkpoint, ...(options.source === 'chatgpt' ? {} : {captureOriginal: originalCapture(op.archive.dir)}),
    maxRecords: positiveInt(options['max-records'], 100000) || 3000,
    batchSize: positiveInt(options['batch-size'], 500) || 100,
    lookback: options.collectorLookback
  })) {
    if (options.collectorLookback !== undefined && Buffer.byteLength(JSON.stringify(batch)) > 8 * 1024 * 1024) {
      throw Object.assign(new Error('Collector batch exceeds its byte budget'), {code: 'COLLECTOR_BATCH_LIMIT'});
    }
    const result = await op.archive.importBatch(batch);
    stats.batches++;
    stats.itemsImported += result.imported || 0;
    stats.batchesReplayed += Number(Boolean(result.replayed));
  }
  if (options.collectorLookback !== undefined) {
    const end = await op.archive.getCheckpoint({ ...op.scope, ...sourceIdentity(source) });
    stats.progressed = (end?.position || 0) > (checkpoint?.position || 0);
    stats.partial = Boolean(end?.source?.coverage?.gaps?.some(g => g.reason === 'scan-limit'));
  }
  return stats;
}

async function ingestTree(op, values) {
  const { discover } = require('../lib/discover.cjs');
  if (!values.root || !values.instance) throw new Error('Provide a source root and instance.');
  const { files, ...coverage } = await discover(values.root, values.source, {
    maximum: positiveInt(values['max-sessions'], 200) || 25,
    offset: positiveInt(values.offset, 20000) || 0, recent: values.recent === true
  });
  const result = { ...coverage, sessionsAttempted: files.length, sessionsFailed: 0, itemsImported: 0 };
  for (const { file, session } of files) {
    try { result.itemsImported += (await ingest(op, { ...values, file, session })).itemsImported; }
    catch { result.sessionsFailed++; }
  }
  return result;
}

async function readEvaluationPredictions() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('Evaluation input exceeds size limit');
    chunks.push(chunk);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  return JSON.parse(text);
}

async function main() {
  const { values, positionals, tokens } = parseArgs({ options, allowPositionals: true, tokens: true });
  const [command, ...extra] = positionals;
  if (values.help || !command) return usage();
  if (extra.length) throw new Error('Unexpected positional argument.');
  if (command === 'training-eval-requests' || command === 'training-eval-score') {
    if (values.synthetic !== true || tokens.filter(token => token.kind === 'option' && token.name === 'synthetic').length !== 1 ||
        Object.keys(values).some(key => key !== 'synthetic')) throw new Error('Invalid synthetic evaluation input');
    const manifest = require('../lib/generated/synthetic-training-manifest.cjs').buildSyntheticTrainingManifest().manifest;
    const test = require('../lib/generated/training-split.cjs').exportTrainingSplit(manifest, 'test');
    const { buildEvaluationRequests, scoreEvaluationResponses } = require('../lib/generated/training-evaluation.cjs');
    const result = command === 'training-eval-requests' ? buildEvaluationRequests(test) : scoreEvaluationResponses(test, await readEvaluationPredictions());
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'training-manifest') {
    if (values.synthetic !== true || tokens.filter(token => token.kind === 'option' && token.name === 'synthetic').length !== 1 ||
        tokens.filter(token => token.kind === 'option' && token.name === 'split').length > 1 ||
        Object.keys(values).some(key => !['synthetic', 'split'].includes(key)) ||
        (values.split !== undefined && !['train', 'test'].includes(values.split))) throw new Error('Invalid synthetic manifest input');
    const envelope = require('../lib/generated/synthetic-training-manifest.cjs').buildSyntheticTrainingManifest();
    const result = values.split === undefined ? envelope : require('../lib/generated/training-split.cjs').exportTrainingSplit(envelope.manifest, values.split);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (values.synthetic !== undefined || values.split !== undefined) throw new Error('Invalid synthetic manifest input');
  if(['draft-publish','draft-review','draft-review-show'].includes(command) || (['draft-list','draft-show'].includes(command) && values.format==='v2')) {
    const allow={ 'draft-publish':['dir','owner','project','receipt','receipt-sha256','expect-latest'], 'draft-review':['dir','owner','project','id','basis','text','topic','primary'], 'draft-review-show':['dir','owner','project','review-id'], 'draft-list':['dir','owner','project','format'], 'draft-show':['dir','owner','project','format','id'] }[command];
    if(!values.dir||!values.owner||!values.project||Object.keys(values).some(k=>!allow.includes(k)))throw Error('Invalid versioned draft input');
    if((command==='draft-show'&&!values.id)||(command==='draft-review-show'&&!values['review-id']))throw Error('Invalid versioned draft input');
    const v=require('../lib/generated/versioned-review.cjs');let result;
    if(command==='draft-publish')result=await v.publish({dir:values.dir,owner:values.owner,project:values.project,receipt:values.receipt,receiptSha256:values['receipt-sha256'],expectLatest:values['expect-latest']});
    else if(command==='draft-review')result=await v.review({dir:values.dir,owner:values.owner,project:values.project,id:values.id,text:values.text,topic:values.topic,...(values.basis!==undefined?{basis:values.basis}:{}),...(values.primary!==undefined?{primary:positiveInt(values.primary,3)}:{})});
    else if(command==='draft-review-show')result=await v.showReview({dir:values.dir,owner:values.owner,project:values.project,reviewId:values['review-id']});
    else result=await v.readV2({dir:values.dir,owner:values.owner,project:values.project,...(command==='draft-show'?{id:values.id}:{})});
    console.log(JSON.stringify(result,null,2));return;
  }
  if (command === 'draft-list' || command === 'draft-show') {
    const { readLocalDraft } = require('../lib/generated/local-draft-read.cjs');
    const { openStorage } = require('../lib/storage.cjs');
    const { openArchive } = require('../lib/archive.cjs');
    const { projectionChoices } = require('../lib/local-derive-selection.cjs');
    const { inspectDraftEvidence } = require('../lib/local-derive-projection.cjs');
    const { result, exitCode } = await readLocalDraft(command, values, { openStorage, openArchive, projectionChoices, inspectDraftEvidence });
    console.log(JSON.stringify(result, null, 2));
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (values.preview && command !== 'find') throw new Error('--preview is supported only by local find.');
  const { operations } = require('../lib/operations.cjs');
  const readCommands = ['find', 'timeline', 'current', 'evidence', 'coverage', 'verify-original', 'original-coverage', 'semantic-status', 'task-list'];
  const readOnly = readCommands.includes(command) || (command === 'mcp' && !values['allow-annotations']);
  const op = await operations({ ...values, readOnly });
  const selection = { ...values, limit: positiveInt(values.limit, command==='task-list'?10000:100), offset: command==='task-list'?nonnegativeInt(values.offset,10000):positiveInt(values.offset,10000), harness: values.source };
  if (values.source && values.instance && values.session) selection.source = { harness: values.source, instance: values.instance, session: values.session };
  else delete selection.source;
  let result;
  switch (command) {
    case 'ingest': result = await ingest(op, values); break;
    case 'repair-original': {
      if (!values.manifest || !values.id || !values.revision) throw Error('Provide manifest, id, and revision');
      const file = await readFile(values.manifest);
      if (file.length > 1024 * 1024) throw Error('Manifest exceeds size limit');
      result = await require('../lib/repair-original.cjs').repairOriginal(op, JSON.parse(file), values.id, values.revision);
      break;
    }
    case 'ingest-tree': result = await ingestTree(op, values); break;
    case 'find': result = await op.find(selection); if (values.preview) result = await require('../lib/find-preview.cjs').addFindPreviews(op.archive, op.scope, selection, result); break;
    case 'timeline': result = await op.timeline(selection); break;
    case 'task-list': result = await op.taskList(selection); break;
    case 'current': result = await op.current(selection); break;
    case 'evidence': result = await op.evidence(selection); break;
    case 'verify-original': {
      const evidence = await op.evidence(selection);
      const { verifyOriginal } = require('../lib/originals.cjs');
      result = await verifyOriginal(op.archive.dir, evidence.original);
      break;
    }
    case 'original-coverage': {
      const allowed=['dir','owner','project','source','instance','session','first-coordinate','last-coordinate','expect-snapshot'];
      if (Object.keys(values).some(key=>!allowed.includes(key)) || !['codex','dsh'].includes(values.source) || !selection.source)
        throw Error('Invalid original coverage options');
      const first=positiveInt(values['first-coordinate'],Number.MAX_SAFE_INTEGER);
      const last=positiveInt(values['last-coordinate'],Number.MAX_SAFE_INTEGER);
      const {auditOriginalCoverage}=require('../lib/generated/original-coverage.cjs');
      const {isArchivedOriginalReference,originalAvailability}=require('../lib/originals.cjs');
      try {
        const data=await op.archive.originalCoverageInputs(op.scope,selection.source,first,last);
        result=await auditOriginalCoverage(first,last,values['expect-snapshot'],data,isArchivedOriginalReference,ref=>originalAvailability(op.archive.dir,ref));
      } catch (error) {
        // Known audit failures are actionable and contain no input data.
        if (!['Stale coverage snapshot','Checkpoint required','Invalid coverage window','Invalid coverage snapshot','Original coverage input limit exceeded'].includes(error.message)) throw error;
        console.error(error.message);
        process.exitCode=1;
        return;
      }
      break;
    }
    case 'coverage': result = await op.coverage(); break;
    case 'migrate-index':
      result = await require('../lib/storage-sqlite.cjs').migrateJsonToSqlite({dir:op.archive.dir});
      break;
    case 'export-index': {
      const { exportSqliteToJson } = require('../lib/storage-sqlite.cjs');
      const { file, ...counts } = await exportSqliteToJson({dir:op.archive.dir});
      result = { ...counts, file: 'archive-export.json' };
      break;
    }
    case 'semantic-status': {
      const { semanticQueueFromSummaries } = require('../lib/semantic-queue.cjs');
      result = semanticQueueFromSummaries(await op.archive.listVersionSummaries(op.scope)).stats;
      break;
    }
    case 'annotate': {
      const fields = Object.fromEntries(['topic', 'basis', 'lifecycle'].filter(key => values[key] !== undefined).map(key => [key, values[key]]));
      if (values.revises) fields.revises = values.revises;
      if (values.evidence !== undefined) fields.evidence = JSON.parse(values.evidence);
      if(values['task-root']!==undefined)fields.taskRoot=JSON.parse(values['task-root']);
      if(values.parents!==undefined)fields.parents=JSON.parse(values.parents);
      if(values.state!==undefined)fields.state=values.state;
      if(values['evidence-kind']!==undefined)fields.evidenceKind=values['evidence-kind'];
      if(values['occurred-at']!==undefined)fields.occurredAt=values['occurred-at'];
      if (values['valid-time']) fields.valid_time = values['valid-time'];
      result = await op.annotate({ ...fields, target: JSON.parse(values.target), kind: values.kind, text: values.text, id: values.id || randomUUID() });
      break;
    }
    case 'watch': {
      if (!values.manifest) throw new Error('Provide a manifest.');
      const { ingestManifest } = require('../lib/daily.cjs');
      const { setTimeout } = require('node:timers/promises');
      const interval = positiveInt(values.interval, 86400) || 60;
      const runs = positiveInt(values.runs, 10000) || Infinity;
      for (let round = 0; round < runs; round++) {
        const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
        const collector = {sessionsAttempted:0,sessionsFailed:0,itemsImported:0,pending:0,blocked:0,unverifiable:0,baselines:0,skippedForBackfill:0,skippedForCapacity:0};
        let usedCollector = false;
        const stats = await ingestManifest(manifest, async input => {
          if (input.incremental === true) {
            if (!input.root) throw new Error('Collector requires a source root');
            usedCollector = true;
            const result = await require('../lib/collector.cjs').collectChanged(op,input,ingest);
            for (const k of ['sessionsAttempted','sessionsFailed','itemsImported','pending','blocked','unverifiable']) collector[k] += result[k] || 0;
            collector.baselines += Number(result.baseline); collector.skippedForBackfill += Number(result.skippedForBackfill); collector.skippedForCapacity += Number(result.skippedForCapacity);
            return result;
          }
          return input.root ? require('../lib/intake.cjs').intakeDirectory(op, input, ingest) : ingest(op, input);
        });
        console.log(JSON.stringify(usedCollector ? {...stats,collector} : stats));
        if (round + 1 < runs) await setTimeout(interval * 1000);
      }
      return;
    }
    case 'daily': {
      const { dailyReview } = require('../lib/daily.cjs');
      const manifest = values.manifest ? JSON.parse(await readFile(values.manifest, 'utf8')) : [];
      const localDraft=values['local-draft'] === true;let exitSignal=0;
      const localDraftRunner=localDraft?async args=>{
        const controller=new AbortController();
        const interrupt=()=>{exitSignal ||= 130;controller.abort();},terminate=()=>{exitSignal ||= 143;controller.abort();};
        process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
        try {return await require('../lib/local-derive.cjs').runLocalDerive({...args,signal:controller.signal});}
        finally {process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
      }:undefined;
      result = await dailyReview(op, manifest, input => input.root ? require('../lib/intake.cjs').intakeDirectory(op, input, ingest) : ingest(op, input), {localDraft,...(localDraftRunner?{localDraftRunner}:{})});
      if(exitSignal)process.exitCode=exitSignal;
      break;
    }
    case 'serve': {
      const { createWebServer } = require('../lib/web/server.cjs');
      const app = createWebServer({ archive: op.archive, ...op.scope, host: '127.0.0.1', port: positiveInt(values.port, 65535) || 8787, externalOrigin: values['serve-origin'], allowedTailnetUser: values['serve-tailnet-user'] });
      const address = await app.listen();
      console.log('http://127.0.0.1:' + address.port);
      return;
    }
    case 'mcp':
      return require('../lib/mcp.cjs').startMcp(op, { allowAnnotations: values['allow-annotations'] });
    case 'provision-hub':
      result = await require('../lib/storage-couch.cjs').provision({
        url: values['couch-url'] || process.env.MEMORY_LAB_COUCH_URL,
        authorization: process.env.MEMORY_LAB_COUCH_AUTHORIZATION
      });
      break;
    case 'sync':
      if (typeof op.archive.sync !== 'function') throw new Error('CouchDB sync is unavailable.');
      result = await op.archive.sync({ ...op.scope, mode: values['sync-mode'] || 'pull', url: values['couch-url'] || process.env.MEMORY_LAB_COUCH_URL, authorization: process.env.MEMORY_LAB_COUCH_AUTHORIZATION });
      break;
    default: throw new Error('Unknown command. Run memory --help.');
  }
  const json = JSON.stringify(result, null, 2);
  // Opt-in preview may contain literal archive text. Escape additional terminal
  // controls on the wire while preserving exact text after JSON parsing.
  console.log(command === 'find' && values.preview ? json.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')) : json);
}

main().catch(error => {
  const safe = ['CORRECTION_EFFECTIVE_TIME','ARCHIVE_NOT_FOUND'].includes(error.code) || /^(Select a project|Provide a source|Invalid numeric|Unexpected positional|CouchDB sync is unavailable|Unknown command)/.test(error.message);
  console.error(safe ? error.message : 'Memory operation failed. Check the scope, inputs, and local service configuration.');
  process.exitCode = 1;
});
