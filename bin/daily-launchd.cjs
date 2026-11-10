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
  const fields = ['dir', 'manifest', 'project', 'owner', 'hour', 'minute'];
  const { values } = parseArgs({ options: Object.fromEntries(fields.map(key => [key, { type: 'string' }])) });
  if (!values.dir || !values.manifest || !values.project) throw new Error('Specify --dir, --manifest, and --project.');
  const hour = Number(values.hour ?? 3), minute = Number(values.minute ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid local schedule.');
  const manifest = resolve(values.manifest);
  if (!Array.isArray(JSON.parse(await readFile(manifest, 'utf8')))) throw new Error('Invalid manifest.');
  const { openStorage } = require('../lib/storage.cjs');
  await openStorage({ dir: values.dir });
  const args = [
    process.execPath, join(__dirname, 'memory.cjs'), 'daily', '--dir', resolve(values.dir),
    '--project', values.project, '--owner', values.owner || 'local', '--manifest', manifest
  ];
  process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.agent-memory-lab.daily</string>
  <key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
</dict></plist>
`);
}

main().catch(() => { console.error('Supply a valid private directory, JSON manifest, project, and local schedule.'); process.exitCode = 1; });
