'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function empty() { return { format: 1, versions: {}, batches: {}, checkpoints: {}, annotations: {} }; }
async function rejectWorktree(dir) {
  // Resolve the nearest existing directory so a symlink into a worktree
  // cannot evade the same check as a direct path.
  let ancestor = dir;
  while (true) {
    try { ancestor = await fs.realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  while (true) {
    let marker;
    try { marker = await fs.lstat(path.join(ancestor, '.git')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (marker || path.basename(ancestor) === '.git') throw new Error('Private archive must be outside Git worktrees');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}
async function openStorage({dir, readOnly = false} = {}) {
  dir = path.resolve(dir || path.join(os.homedir(), '.local', 'share', 'agent-memory-lab'));
  await rejectWorktree(dir);
  if (!readOnly) await fs.mkdir(dir, {recursive:true, mode:0o700});
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Archive directory must be private and not a symlink');
  const file = path.join(dir, 'archive.json');
  async function read() {
    try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Archive file must be private and not a symlink'); const state = JSON.parse(await fs.readFile(file, 'utf8')); if (state.format !== 1) throw new Error('Unsupported archive format'); return state; }
    catch (err) { if (err.code === 'ENOENT') return empty(); throw err; }
  }
  async function transaction(fn) {
    if (readOnly) throw new Error('Archive is read-only');
    const lock = path.join(dir, '.archive.lock');
    let handle;
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') throw new Error('Archive is locked; retry after the other writer finishes'); throw err; }
    try {
      const state = await read();
      const result = await fn(state);
      const temp = path.join(dir, `.archive-${crypto.randomUUID()}.tmp`);
      try {
        const out = await fs.open(temp, 'wx', 0o600);
        try { await out.writeFile(JSON.stringify(state)); await out.sync(); } finally { await out.close(); }
        await fs.rename(temp, file);
      } finally { await fs.rm(temp, {force:true}); }
      return result;
    } finally { await handle.close(); await fs.rm(lock, {force:true}); }
  }
  return {dir, read, transaction};
}
module.exports = {openStorage, canonical, digest};
