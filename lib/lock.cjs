'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {setTimeout:delay} = require('node:timers/promises');

// SQLite's operating-system locks are released by the kernel when a writer dies.
// Separate names serialize independent derived products without holding the archive lock.
async function withWriterLock(dir, name, fn, {timeoutMs = 10000, retryMs = 50, legacyLock} = {}) {
  if (typeof name !== 'string' || !name || typeof fn !== 'function') throw new Error('Invalid writer lock');
  if (legacyLock && (typeof legacyLock !== 'string' || path.basename(legacyLock) !== legacyLock || legacyLock === '.' || legacyLock === '..')) throw new Error('Invalid legacy marker');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs < 1) throw new Error('Invalid lock timeout');
  const file = path.join(dir, `.writer-${crypto.createHash('sha256').update(name).digest('hex')}.sqlite`);
  try { const h = await fs.open(file,'wx',0o600); await h.close(); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Writer lock file must be private');
  const db = new DatabaseSync(file, {timeout:0});
  let locked = false, markerOwned = false;
  const marker = legacyLock && path.join(dir, legacyLock);
  const magic = 'agent-memory-writer-v1:';
  const token = magic + crypto.randomBytes(32).toString('hex');
  async function clearOwned() {
    if (!markerOwned) return;
    const content = await fs.readFile(marker,'utf8');
    if (content !== token) throw new Error('Writer marker changed unexpectedly');
    await fs.unlink(marker); markerOwned = false;
  }
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); locked = true; }
      catch (err) { if (err.errcode !== 5 && err.errcode !== 6) throw err; }
      if (locked && marker) {
        // Only this SQLite lock holder may identify and recover a marker from a dead new writer.
        try {
          const info = await fs.lstat(marker);
          if (info.isFile() && !info.isSymbolicLink() && info.size === magic.length + 64 && !(info.mode & 0o077)) {
            const content = await fs.readFile(marker,'utf8');
            if (/^agent-memory-writer-v1:[0-9a-f]{64}$/.test(content)) await fs.unlink(marker);
          }
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
        const temp = path.join(dir, `.marker-${crypto.randomUUID()}.tmp`);
        try {
          const fd = await fs.open(temp,'wx',0o600);
          try { await fd.writeFile(token); await fd.sync(); } finally { await fd.close(); }
          try { await fs.link(temp,marker); markerOwned = true; }
          catch (err) { if (err.code !== 'EEXIST') throw err; }
        } finally { await fs.rm(temp,{force:true}); }
        if (!markerOwned) { db.exec('ROLLBACK'); locked = false; }
      }
      if (locked) break;
      if (Date.now() >= deadline) throw new Error('Writer lock wait timed out');
      await delay(Math.min(retryMs, Math.max(1,deadline-Date.now())));
    }
    const result = await fn();
    await clearOwned();
    db.exec('COMMIT'); locked = false;
    return result;
  } finally {
    try { if (markerOwned) await clearOwned(); }
    finally {
      if (locked) { try { db.exec('ROLLBACK'); } catch {} }
      db.close();
    }
  }
}
module.exports = {withWriterLock};
