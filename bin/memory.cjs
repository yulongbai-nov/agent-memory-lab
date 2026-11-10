#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const options = Object.fromEntries([
  'dir', 'owner', 'project', 'keyword', 'from', 'to', 'limit', 'id', 'revision',
  'source', 'file', 'instance', 'session', 'max-records', 'batch-size', 'port',
  'kind', 'text', 'manifest', 'target', 'evidence', 'topic', 'offset', 'couch-url', 'root', 'sync-mode', 'max-sessions', 'basis', 'lifecycle', 'revises', 'interval', 'runs', 'valid-time', 'serve-origin', 'serve-tailnet-user'
].map(name => [name, { type: 'string' }]));
options.recent = { type: 'boolean' };
options['local-draft'] = { type: 'boolean' };
options.help = { type: 'boolean', short: 'h' };
options['allow-annotations'] = { type: 'boolean' };

function usage() {
  console.log(`Usage: memory <command> --project PROJECT [--dir PRIVATE_DIRECTORY]
Commands:
  ingest --source dsh|codex --file FILE --instance INSTANCE --session SESSION
         [--max-records N] [--batch-size N]
  ingest-tree --source dsh|codex --root DIRECTORY --instance INSTANCE [--max-sessions N] [--offset N]
  find [--keyword TEXT] [--from DATE] [--to DATE] [--limit N]
  timeline --topic TOPIC [--from DATE] [--to DATE]
  current --topic TOPIC
  evidence --id ID --revision VERSION --source dsh|codex --instance INSTANCE --session SESSION
  verify-original --id ID --revision VERSION
  coverage
  migrate-index
  export-index
  annotate --target CITATION_JSON --kind note|correction|decision|change|todo --text TEXT [--id RETRY_ID] [--evidence CITATION_JSON]
  watch --manifest PRIVATE_JSON [--interval SECONDS] [--runs N]
  semantic-status
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

async function ingest(op, options) {
  const { readCodex, readDsh, sourceIdentity } = require('../lib/adapters');
  const read = { codex: readCodex, dsh: readDsh }[options.source];
  if (!read || !options.file || !options.instance || !options.session) throw new Error('Provide a source, file, instance, and session.');
  const source = { ...op.scope, harness: options.source, instance: options.instance, session: options.session };
  const checkpoint = await op.archive.getCheckpoint({ ...op.scope, ...sourceIdentity(source) });
  const stats = { batches: 0, itemsImported: 0, batchesReplayed: 0 };
  const { originalCapture } = require('../lib/originals.cjs');
  for await (const batch of read({
    ...source, file: options.file, checkpoint, captureOriginal: originalCapture(op.archive.dir),
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

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  const [command, ...extra] = positionals;
  if (values.help || !command) return usage();
  if (extra.length) throw new Error('Unexpected positional argument.');
  const { operations } = require('../lib/operations.cjs');
  const readCommands = ['find', 'timeline', 'current', 'evidence', 'coverage', 'verify-original', 'semantic-status'];
  const readOnly = readCommands.includes(command) || (command === 'mcp' && !values['allow-annotations']);
  const op = await operations({ ...values, readOnly });
  const selection = { ...values, limit: positiveInt(values.limit, 100), offset: positiveInt(values.offset, 10000), harness: values.source };
  if (values.source && values.instance && values.session) selection.source = { harness: values.source, instance: values.instance, session: values.session };
  else delete selection.source;
  let result;
  switch (command) {
    case 'ingest': result = await ingest(op, values); break;
    case 'ingest-tree': result = await ingestTree(op, values); break;
    case 'find': result = await op.find(selection); break;
    case 'timeline': result = await op.timeline(selection); break;
    case 'current': result = await op.current(selection); break;
    case 'evidence': result = await op.evidence(selection); break;
    case 'verify-original': {
      const evidence = await op.evidence(selection);
      const { verifyOriginal } = require('../lib/originals.cjs');
      result = await verifyOriginal(op.archive.dir, evidence.original);
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
        const collector = {sessionsAttempted:0,sessionsFailed:0,itemsImported:0,pending:0,blocked:0,baselines:0,skippedForBackfill:0,skippedForCapacity:0};
        let usedCollector = false;
        const stats = await ingestManifest(manifest, async input => {
          if (input.incremental === true) {
            if (!input.root) throw new Error('Collector requires a source root');
            usedCollector = true;
            const result = await require('../lib/collector.cjs').collectChanged(op,input,ingest);
            for (const k of ['sessionsAttempted','sessionsFailed','itemsImported','pending','blocked']) collector[k] += result[k];
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
      result = await dailyReview(op, manifest, input => input.root ? require('../lib/intake.cjs').intakeDirectory(op, input, ingest) : ingest(op, input), {localDraft:values['local-draft'] === true});
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
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  const safe = ['CORRECTION_EFFECTIVE_TIME','ARCHIVE_NOT_FOUND'].includes(error.code) || /^(Select a project|Provide a source|Invalid numeric|Unexpected positional|CouchDB sync is unavailable|Unknown command)/.test(error.message);
  console.error(safe ? error.message : 'Memory operation failed. Check the scope, inputs, and local service configuration.');
  process.exitCode = 1;
});
