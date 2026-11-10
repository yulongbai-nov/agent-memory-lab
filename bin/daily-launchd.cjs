#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { resolve, join } = require('node:path');
const { readFile } = require('node:fs/promises');

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

async function main() {
  const fields = ['dir', 'manifest', 'project', 'owner', 'hour', 'minute', 'interval-seconds', 'label'];
  const options = Object.fromEntries(fields.map(key => [key, { type: 'string' }]));
  options['local-draft'] = { type: 'boolean' };
  const { values } = parseArgs({ options });
  if (!values.dir || !values.manifest || !values.project) throw new Error('Specify --dir, --manifest, and --project.');
  const interval = values['interval-seconds'] === undefined ? null : Number(values['interval-seconds']);
  const collector = interval !== null;
  if (collector && values['local-draft']) throw new Error('Local drafts require daily scheduling.');
  const label = values.label || (collector ? 'local.agent-memory-lab.collector' : 'local.agent-memory-lab.daily');
  const hour = Number(values.hour ?? 3), minute = Number(values.minute ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid local schedule.');
  if (collector && (!Number.isInteger(interval) || interval < 30 || interval > 3600 ||
      !/^local\.agent-memory-lab\.collector(?:\.[a-z0-9-]+)?$/.test(label))) throw new Error('Invalid collector schedule.');
  if (!collector && values.label) throw new Error('Daily task uses its fixed label.');
  const manifest = resolve(values.manifest);
  const entries = JSON.parse(await readFile(manifest, 'utf8'));
  if (!Array.isArray(entries) || (collector && (!entries.length || entries.some(entry => !entry?.root || entry.incremental !== true)))) {
    throw new Error('Collector requires an incremental directory manifest.');
  }
  const { openStorage } = require('../lib/storage.cjs');
  await openStorage({ dir: values.dir });
  const args = [
    process.execPath,
    ...(collector ? ['--max-old-space-size=1100', '--max-semi-space-size=16'] : []),
    join(__dirname, 'memory.cjs'), collector ? 'watch' : 'daily',
    '--dir', resolve(values.dir), '--project', values.project,
    '--owner', values.owner || 'local', '--manifest', manifest,
    ...(collector ? ['--runs', '1'] : []),
    ...(!collector && values['local-draft'] ? ['--local-draft'] : [])
  ];
  process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
  ${collector ? `<key>StartInterval</key><integer>${interval}</integer>` :
    `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`}
</dict></plist>
`);
}

main().catch(() => { console.error('Supply a valid private directory, JSON manifest, project, and local schedule.'); process.exitCode = 1; });
