"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { readCodex } = require("../lib/adapters");
const { openArchive } = require("../lib/archive.cjs");
const {
  originalCapture,
  verifyOriginal,
  readVerifiedOriginal,
} = require("../lib/originals.cjs");

test("synthetic Codex import preserves a large original while model projection stays bounded", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "large-original-acceptance-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = path.join(dir, "store");
  await fs.mkdir(store, { mode: 0o700 });
  const file = path.join(dir, "session.jsonl");
  const line = Buffer.from(
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "synthetic-" + "x".repeat(1024 * 1024) },
        ],
      },
    }) + "\n",
  );
  assert(line.length > 1024 * 1024);
  await fs.writeFile(file, line);
  const scope = { owner: "synthetic", project: "acceptance" };
  const archive = await openArchive({ dir: store });
  t.after(() => archive.close?.());
  for await (const batch of readCodex({
    ...scope,
    file,
    instance: "synthetic",
    session: "one",
    captureOriginal: originalCapture(store),
  }))
    await archive.importBatch(batch);
  const rows = await archive.listItems(scope);
  assert.equal(rows.length, 1);
  const ref = rows[0].item.metadata.original;
  assert.equal(ref.availability, "archived");
  assert.equal(ref.bytes, line.length);
  assert.equal(
    ref.sha256,
    crypto.createHash("sha256").update(line).digest("hex"),
  );
  assert.deepEqual(
    await fs.readFile(path.join(store, "originals", ref.sha256 + ".jsonl")),
    line,
  );
  assert.equal((await verifyOriginal(store, ref)).verified, true);
  assert.equal((await readVerifiedOriginal(store, ref)).status, "too-large");
  assert.equal(
    (await archive.listItems({ owner: "synthetic", project: "other" })).length,
    0,
  );
});

test("targeted repair appends one observation, preserves its old version and checkpoint, and retries safely", async (t) => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const run = promisify(execFile);
  const { sourceIdentity } = require("../lib/adapters");
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "large-original-repair-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = path.join(dir, "store");
  await fs.mkdir(store, { mode: 0o700 });
  const file = path.join(dir, "session.jsonl");
  const record = (id, text) =>
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "response_item",
      payload: {
        type: "message",
        id,
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }) + "\n";
  const first = Buffer.from(
    record("one", "synthetic-" + "x".repeat(1024 * 1024)),
  );
  await fs.writeFile(
    file,
    Buffer.concat([
      first,
      Buffer.from(record("two", "other synthetic record")),
    ]),
  );
  const scope = { owner: "synthetic", project: "repair" };
  const source = { harness: "codex", instance: "synthetic", session: "one" };
  let archive = await openArchive({ dir: store });
  t.after(() => archive.close?.());
  const legacyCapture = async ({ bytes, coordinate }) =>
    bytes.length > 1024 * 1024
      ? { availability: "source-only", reason: "record-size-limit", coordinate }
      : originalCapture(store)({ bytes, coordinate });
  for await (const batch of readCodex({
    ...scope,
    file,
    instance: source.instance,
    session: source.session,
    captureOriginal: legacyCapture,
  }))
    await archive.importBatch(batch);
  archive.close?.();
  await require("../lib/storage-sqlite.cjs").migrateJsonToSqlite({
    dir: store,
  });
  archive = await openArchive({ dir: store });
  const before = await archive.listItems(scope);
  assert.equal(before.length, 2);
  const old = before.find((row) => row.item.metadata.coordinate === 1);
  assert.equal(old.item.metadata.original.reason, "record-size-limit");
  const key = { ...scope, ...sourceIdentity(source) };
  const checkpoint = await archive.getCheckpoint(key);
  const manifest = path.join(dir, "manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify([
      {
        source: "codex",
        file,
        instance: source.instance,
        session: source.session,
      },
    ]),
  );
  const args = [
    path.join(__dirname, "../bin/memory.cjs"),
    "repair-original",
    "--manifest",
    manifest,
    "--id",
    old.item.id,
    "--revision",
    old.versionId,
    "--dir",
    store,
    "--owner",
    scope.owner,
    "--project",
    scope.project,
  ];
  const repair = async () =>
    JSON.parse((await run(process.execPath, args)).stdout);
  await repair();
  const after = await archive.listItems(scope);
  assert.equal(after.length, 3);
  const restored = after.find(
    (row) => row.item.id === old.item.id && row.versionId !== old.versionId,
  );
  assert.equal(restored.item.metadata.original.availability, "archived");
  assert.equal(
    restored.item.metadata.original.sha256,
    crypto.createHash("sha256").update(first).digest("hex"),
  );
  assert.equal(
    (await verifyOriginal(store, restored.item.metadata.original)).verified,
    true,
  );
  assert.deepEqual(
    await archive.getItem({
      ...scope,
      id: old.item.id,
      revision: old.versionId,
    }),
    old,
  );
  assert.deepEqual(await archive.getCheckpoint(key), checkpoint);
  assert.equal(
    after.filter((row) => row.item.metadata.coordinate === 2).length,
    1,
  );
  await repair();
  assert.equal((await archive.listItems(scope)).length, 3);
  assert.deepEqual(await archive.getCheckpoint(key), checkpoint);
});
