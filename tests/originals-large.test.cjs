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

test("original coverage CLI audits scoped metadata and rejects stale snapshots", async (t) => {
  const { openArchive } = require("../lib/archive.cjs"),
    { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs"),
    { spawnSync } = require("node:child_process");
  const dir = await fixture(t),
    scope = { owner: "synthetic", project: "coverage" },
    source = { harness: "dsh", instance: "archived", session: "session" },
    capture = originalCapture(dir),
    first = await capture({
      bytes: Buffer.from("private first original"),
      coordinate: 1,
    }),
    missing = await capture({
      bytes: Buffer.from("private missing original"),
      coordinate: 2,
    }),
    conflictA = await capture({
      bytes: Buffer.from("private conflict a"),
      coordinate: 5,
    }),
    conflictB = await capture({
      bytes: Buffer.from("private conflict b"),
      coordinate: 5,
    });
  const item = (id, coordinate, original) => ({
    id,
    kind: "message",
    text: "PRIVATE BODY",
    metadata: { coordinate, original },
  });
  const archive = await openArchive({ dir });
  await archive.importBatch({
    scope,
    source,
    checkpoint: { position: 6 },
    items: [
      item("one", 1, {
        availability: "source-only",
        reason: "not-captured",
        coordinate: 1,
      }),
      item("missing", 2, missing),
      item("only", 3, {
        availability: "source-only",
        reason: "not-captured",
        coordinate: 3,
      }),
      item("invalid", 4, {
        availability: "archived",
        coordinate: 4,
        sha256: "invalid",
        bytes: 1,
      }),
      item("conflict-a", 5, conflictA),
      item("conflict-b", 5, conflictB),
      item("outside-horizon", 7, {
        availability: "source-only",
        coordinate: 7,
      }),
    ],
  });
  // A later archived observation of the same item supersedes its source-only variant.
  await archive.importBatch({
    scope,
    source,
    checkpoint: { previous: 6, position: 6 },
    items: [item("one", 1, first)],
  });
  await archive.importBatch({
    scope: { ...scope, project: "other" },
    source,
    checkpoint: { position: 6 },
    items: [item("other-scope", 3, first)],
  });
  await archive.importBatch({
    scope,
    source: { ...source, instance: "other" },
    checkpoint: { position: 6 },
    items: [item("other-source", 3, first)],
  });
  await fs.writeFile(
    path.join(dir, "originals", first.sha256 + ".jsonl"),
    Buffer.alloc(first.bytes, 0x78),
  );
  await fs.rm(path.join(dir, "originals", missing.sha256 + ".jsonl"));
  const run = (extra = []) =>
    spawnSync(
      process.execPath,
      [
        path.join(__dirname, "../bin/memory.cjs"),
        "original-coverage",
        "--dir",
        dir,
        "--owner",
        scope.owner,
        "--project",
        scope.project,
        "--source",
        "dsh",
        "--instance",
        source.instance,
        "--session",
        source.session,
        "--first-coordinate",
        "1",
        "--last-coordinate",
        "7",
        ...extra,
      ],
      { encoding: "utf8" },
    );
  const check = () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    for (const secret of [
      dir,
      "PRIVATE BODY",
      "private first original",
      first.sha256,
      missing.sha256,
      conflictA.sha256,
      conflictB.sha256,
    ])
      assert.ok(!result.stdout.includes(secret));
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, "original-coverage-v1");
    assert.match(output.snapshot, /^[a-f0-9]{64}$/);
    assert.equal(output.first, 1);
    assert.equal(output.last, 7);
    assert.equal(output.checkpoint.position, 6);
    assert.equal(output.checkpoint.coverageComplete, null);
    assert.equal(output.checkpoint.priorRangeUnverified, null);
    assert.deepEqual(
      output.rows.map((row) => [row.coordinate, row.status]),
      [
        [1, "metadata-present"],
        [2, "missing-locally"],
        [3, "source-only"],
        [4, "invalid-metadata"],
        [5, "ambiguous"],
        [6, "unrepresented"],
        [7, "uncheckpointed"],
      ],
    );
    assert.ok(output.rows.every((row) => Number.isSafeInteger(row.versions)));
    assert.ok(output.counts && typeof output.counts === "object");
    return output;
  };
  const json = check();
  archive.close?.();
  await migrateJsonToSqlite({ dir });
  const sqlite = check();
  assert.deepEqual(sqlite.rows, json.rows);
  assert.deepEqual(sqlite.counts, json.counts);
  assert.equal(run(["--expect-snapshot", sqlite.snapshot]).status, 0);
  const writer = await openArchive({ dir });
  await writer.importBatch({
    scope,
    source: { ...source, session: "other-session" },
    checkpoint: { position: 1 },
    items: [item("unrelated", 1, first)],
  });
  assert.equal(run(["--expect-snapshot", sqlite.snapshot]).status, 0);
  const { checkpointRevision } = require("../lib/checkpoint.cjs");
  const before = await writer.getCheckpoint({ ...scope, ...source });
  const coverage = { complete: false, priorRangeUnverified: true };
  await writer.importBatch({
    scope,
    source: { ...source, coverage },
    checkpoint: {
      previous: 6,
      position: 6,
      previousRevision: checkpointRevision(before),
    },
    items: [],
  });
  writer.close?.();
  const stale = run(["--expect-snapshot", sqlite.snapshot]);
  assert.notEqual(stale.status, 0);
  assert.equal(stale.stdout.trim(), "");
  assert.match(stale.stderr, /stale coverage snapshot/i);
  const refreshed = run();
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.deepEqual(JSON.parse(refreshed.stdout).checkpoint, {
    position: 6,
    coverageComplete: false,
    priorRangeUnverified: true,
  });
});
