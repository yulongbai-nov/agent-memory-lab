'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { link, lstat, mkdir, open, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 16 * MAX_RECORD_BYTES;
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
    if (bytes.length > MAX_RECORD_BYTES) return { availability: 'source-only', reason: 'record-size-limit', coordinate };
    await (ready ||= privateDirectory(folder, true));
    const reference = { availability: 'archived', format: 'jsonl-record', coordinate, sha256: hash(bytes), bytes: bytes.length };
    const target = originalPath(dir, reference);
    try {
      await checkFile(target, bytes.length);
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
        await checkFile(target, bytes.length);
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

async function verifyOriginal(dir, reference) {
  const local = await originalAvailability(dir, reference);
  const file = originalPath(dir, local);
  if (!file) return { ...local, verified: false };
  const bytes = await readFile(file);
  return { ...local, verified: hash(bytes) === local.sha256 };
}

async function readVerifiedOriginal(dir, reference) {
  if (reference == null || reference.availability === 'source-only') return {status:'source-only'};
  const file = originalPath(dir, reference);
  if (!file) return {status:'integrity-failed'};
  let handle;
  try {
    await privateDirectory(join(dir,'originals'));
    handle = await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const st = await handle.stat();
    if (!st.isFile() || (st.mode & 0o077) || st.size !== reference.bytes) return {status:'integrity-failed'};
    const buffer = Buffer.alloc(st.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer,length,buffer.length-length,length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0,length);
    if (length !== reference.bytes || hash(bytes) !== reference.sha256) return {status:'integrity-failed'};
    return {status:'verified',bytes,sha256:reference.sha256};
  } catch (error) {
    return {status:error.code === 'ENOENT'?'missing-locally':'integrity-failed'};
  } finally { await handle?.close(); }
}

module.exports = { originalCapture, originalAvailability, verifyOriginal, readVerifiedOriginal };
