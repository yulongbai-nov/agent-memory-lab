"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  originalCapture,
  originalAvailability,
  verifyOriginal,
  readVerifiedOriginal,
} = require("../lib/originals.cjs");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "large-original-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("large originals remain exact and verified without entering model projection", async (t) => {
  const dir = await fixture(t),
    bytes = Buffer.alloc(1024 * 1024 + 31, 0x61);
  const capture = originalCapture(dir),
    ref = await capture({ bytes, coordinate: 7 });
  assert.equal(ref.availability, "archived");
  assert.equal((await originalAvailability(dir, ref)).availability, "archived");
  assert.equal((await verifyOriginal(dir, ref)).verified, true);
  assert.deepEqual(await readVerifiedOriginal(dir, ref), {
    status: "too-large",
  });
  const file = path.join(dir, "originals", ref.sha256 + ".jsonl");
  assert.deepEqual(await fs.readFile(file), bytes);
  await fs.writeFile(file, Buffer.alloc(bytes.length, 0x62));
  assert.equal((await verifyOriginal(dir, ref)).verified, false);
  assert.equal(
    (await readVerifiedOriginal(dir, ref)).status,
    "integrity-failed",
  );
  await assert.rejects(
    capture({ bytes, coordinate: 7 }),
    /Invalid archived original/,
  );
});
test("record and per-scan limits preserve existing content without spending budget twice", async (t) => {
  const dir = await fixture(t),
    capture = originalCapture(dir),
    limit = 16 * 1024 * 1024;
  const bytes = Buffer.alloc(limit, 0x63),
    ref = await capture({ bytes, coordinate: 1 });
  assert.equal(ref.availability, "archived");
  assert.equal(
    (await capture({ bytes, coordinate: 2 })).availability,
    "archived",
  );
  assert.equal(
    (await capture({ bytes: Buffer.from("x"), coordinate: 3 })).reason,
    "scan-byte-limit",
  );
  assert.equal(
    (await capture({ bytes: Buffer.alloc(limit + 1), coordinate: 4 })).reason,
    "record-size-limit",
  );
  assert.equal((await verifyOriginal(dir, ref)).verified, true);
});
test("verification rejects symlinks and unsafe permissions", async (t) => {
  const dir = await fixture(t),
    bytes = Buffer.alloc(1024 * 1024 + 1, 0x64);
  const ref = await originalCapture(dir)({ bytes, coordinate: 1 });
  const file = path.join(dir, "originals", ref.sha256 + ".jsonl");
  await fs.chmod(file, 0o644);
  assert.equal((await verifyOriginal(dir, ref)).verified, false);
  await fs.chmod(file, 0o600);
  const copy = path.join(dir, "copy");
  await fs.rename(file, copy);
  await fs.symlink(copy, file);
  assert.equal((await verifyOriginal(dir, ref)).verified, false);
  assert.equal(
    (await readVerifiedOriginal(dir, ref)).status,
    "integrity-failed",
  );
});
