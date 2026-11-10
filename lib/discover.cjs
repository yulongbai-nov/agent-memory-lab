'use strict';

const { readdir, realpath, lstat } = require('node:fs/promises');
const path = require('node:path');

async function discover(root, harness, { maximum = 25, offset = 0, recent = false } = {}) {
  if (!['dsh', 'codex'].includes(harness)) throw new Error('Unknown source format.');
  const base = await realpath(root);
  const paths = [];
  let inaccessible = 0, visited = 0;
  let traversalLimited = false;
  async function scan(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (dir === base) throw error;
      inaccessible++;
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 20000) { traversalLimited = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full);
      else if (entry.isFile() && (harness === 'dsh' ? entry.name === 'session.v4.jsonl.zstd' : entry.name.endsWith('.jsonl'))) {
        paths.push(full);
      }
      if (traversalLimited) return;
    }
  }
  await scan(base);
  if (recent) {
    const times = new Map();
    for (const file of paths) {
      try { times.set(file, (await lstat(file)).mtimeMs); }
      catch { inaccessible++; }
    }
    paths.sort((a, b) => (times.get(b) || 0) - (times.get(a) || 0) || a.localeCompare(b));
  }
  const page = paths.slice(offset, offset + maximum);
  const files = [];
  for (const file of page) {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || await realpath(file) !== file) throw new Error('Source moved during scan.');
      files.push({ file, session: path.relative(base, file) });
    } catch { inaccessible++; }
  }
  return { files, inaccessible, discovered: paths.length, traversalLimited, nextOffset: paths.length > offset + maximum ? offset + maximum : null };
}
module.exports = { discover };
