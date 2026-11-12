'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { link, lstat, mkdir, open, rm } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_MODEL_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 16 * MAX_MODEL_BYTES;
const MAX_SCAN_BYTES = 16 * MAX_MODEL_BYTES;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function privateDirectory(dir, create = false) {
  if (create) await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('Originals directory must be private.');
}

function originalPath(dir, reference) {
  if (reference?.availability !== 'archived' || typeof reference.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 1 || reference.bytes > MAX_RECORD_BYTES) return null;
  return join(dir, 'originals', reference.sha256 + '.jsonl');
}

async function checkFile(file, expectedBytes) {
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o077) || info.size !== expectedBytes) throw new Error('Invalid archived original.');
}

function originalCapture(dir) {
  const folder = join(dir, 'originals');
  let writtenBytes = 0;
  let ready;
  return async ({ bytes, coordinate }) => {
    if (!Buffer.isBuffer(bytes)) throw new Error('Original capture requires source bytes.');
    if (bytes.length < 1 || bytes.length > MAX_RECORD_BYTES) return { availability: 'source-only', reason: 'record-size-limit', coordinate };
    await (ready ||= privateDirectory(folder, true));
    const reference = { availability: 'archived', format: 'jsonl-record', coordinate, sha256: hash(bytes), bytes: bytes.length };
    const target = originalPath(dir, reference);
    try {
      await checkFile(target, bytes.length);
      if (!(await verifyOriginal(dir, reference)).verified) throw new Error('Invalid archived original.');
      return reference;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (writtenBytes + bytes.length > MAX_SCAN_BYTES) return { availability: 'source-only', reason: 'scan-byte-limit', coordinate };
    const temp = join(folder, '.' + randomUUID() + '.tmp');
    try {
      const fd = await open(temp, 'wx', 0o600);
      try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
      try {
        await link(temp, target);
        writtenBytes += bytes.length;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await verifyOriginal(dir, reference)).verified) throw new Error('Invalid archived original.');
      }
    } finally {
      await rm(temp, { force: true });
    }
    return reference;
  };
}

async function originalAvailability(dir, reference) {
  if (!reference) return { availability: 'source-only', reason: 'not-captured' };
  const file = dir && originalPath(dir, reference);
  if (!file) return { ...reference, availability: reference.availability === 'archived' ? 'missing-locally' : 'source-only' };
  try {
    await privateDirectory(join(dir, 'originals'));
    await checkFile(file, reference.bytes);
    return reference;
  } catch {
    return { ...reference, availability: 'missing-locally' };
  }
}

// Stream the exact bounded length through SHA-256 while holding a no-follow file
// descriptor. The extra read detects growth, and final stat detects metadata changes.
async function readOriginal(dir, reference, collect) {
  if (reference == null || reference.availability === 'source-only') return {status:'source-only'};
  const file = dir && originalPath(dir, reference);
  if (!file) return {status:'integrity-failed'};
  let handle;
  try {
    await privateDirectory(join(dir,'originals'));
    handle = await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || (st.mode & 0o077) || st.size !== reference.bytes) return {status:'integrity-failed'};
    const digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
    const output = collect ? Buffer.alloc(reference.bytes) : null;
    let length = 0;
    while (length <= reference.bytes) {
      const {bytesRead} = await handle.read(chunk,0,Math.min(chunk.length,reference.bytes + 1 - length),length);
      if (!bytesRead) break;
      if (length + bytesRead > reference.bytes) return {status:'integrity-failed'};
      digest.update(chunk.subarray(0,bytesRead));
      if (output) chunk.copy(output,length,0,bytesRead);
      length += bytesRead;
    }
    const end = await handle.stat();
    if (length !== reference.bytes || !end.isFile() || (end.mode & 0o077) || end.size !== reference.bytes || digest.digest('hex') !== reference.sha256) return {status:'integrity-failed'};
    return {status:'verified',...(output ? {bytes:output} : {}),sha256:reference.sha256};
  } catch (error) {
    return {status:error.code === 'ENOENT'?'missing-locally':'integrity-failed'};
  } finally { await handle?.close(); }
}

async function verifyOriginal(dir, reference) {
  const result = await readOriginal(dir, reference, false);
  const local = await originalAvailability(dir, reference);
  return { ...local, verified: result.status === 'verified' && local.availability === 'archived' };
}

async function readVerifiedOriginal(dir, reference) {
  // A large archived record remains available for audit, but never enters a
  // model projection or requires allocation of its full contents.
  if (originalPath(dir || '', reference) && reference.bytes > MAX_MODEL_BYTES) {
    const result = await readOriginal(dir, reference, false);
    return result.status === 'verified' ? {status:'too-large'} : result;
  }
  return readOriginal(dir, reference, true);
}

module.exports = { originalCapture, originalAvailability, verifyOriginal, readVerifiedOriginal };
