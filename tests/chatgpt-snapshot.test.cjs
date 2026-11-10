"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { openArchive } = require("../lib/archive.cjs");
const { sourceIdentity } = require("../lib/adapters");
const { readChatgptSnapshot } = require("../lib/adapters/chatgpt-snapshot.cjs");

function fixture(representation = "connector-projection") {
  return {
    schema: "agent-memory-chatgpt-snapshot",
    version: 1,
    representation,
    conversation: {
      id: "synthetic-thread",
      created_at: "2026-01-01T00:00:00Z",
      branches_complete: false,
      attachments_complete: false,
    },
    messages: [1, 2, 3].map((n) => ({
      id: `message-${n}`,
      role: n === 2 ? "assistant" : "user",
      text: `synthetic ${n}`,
      created_at: `2026-01-01T00:00:0${n}Z`,
      truncated: n === 2,
    })),
  };
}
test("snapshot import resumes bounded batches, preserves coverage, and enforces CAS", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-snapshot-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json");
  await fs.writeFile(file, JSON.stringify(fixture()));
  const archive = await openArchive({ dir: path.join(dir, "archive") });
  const opts = {
    file,
    owner: "synthetic",
    project: "fixture",
    instance: "test",
    session: "synthetic-thread",
    maxRecords: 2,
    batchSize: 1,
  };
  const batches = [];
  for await (const batch of readChatgptSnapshot(opts)) batches.push(batch);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].items[0].metadata.originalBytes, false);
  assert.equal(batches[1].items[0].metadata.truncated, true);
  assert.equal(Object.hasOwn(batches[1].items[0], "text"), false);
  assert.deepEqual(
    batches[1].source.coverage.gaps.map((g) => g.reason),
    [
      "connector-projection",
      "branches-incomplete",
      "attachments-incomplete",
      "truncated-items",
      "scan-limit",
    ],
  );
  for (const batch of batches) await archive.importBatch(batch);
  await assert.rejects(
    archive.importBatch({
      ...batches[0],
      items: [{ ...batches[0].items[0], text: "conflict" }],
    }),
    /Checkpoint conflict/,
  );
  const checkpoint = await archive.getCheckpoint({
    ...opts,
    ...sourceIdentity({
      harness: "chatgpt",
      instance: opts.instance,
      session: opts.session,
    }),
  });
  const resumed = [];
  for await (const batch of readChatgptSnapshot({ ...opts, checkpoint }))
    resumed.push(batch);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].checkpoint.previous, 2);
  await archive.importBatch(resumed[0]);
  const final = await archive.getCheckpoint({
    ...opts,
    ...sourceIdentity({
      harness: "chatgpt",
      instance: opts.instance,
      session: opts.session,
    }),
  });
  assert.equal(final.position, 3);
  assert.equal((await archive.listItems(opts)).length, 3);
  const again = [];
  for await (const batch of readChatgptSnapshot({ ...opts, checkpoint: final }))
    again.push(batch);
  assert.deepEqual(again, []);
  await fs.writeFile(
    file,
    JSON.stringify({ ...fixture(), messages: fixture().messages.slice(0, 2) }),
  );
  await assert.rejects(
    () => readChatgptSnapshot({ ...opts, checkpoint: final }).next(),
    /checkpoint mismatch/,
  );
});
test("rejects unknown shape and distinguishes normalized export completeness", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-snapshot-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json");
  const opts = {
    file,
    owner: "o",
    project: "p",
    instance: "i",
    session: "synthetic-thread",
  };
  for (const bad of [
    { ...fixture(), version: 2 },
    { ...fixture(), unknown: true },
    { ...fixture(), messages: [{ ...fixture().messages[0], id: "" }] },
  ]) {
    await fs.writeFile(file, JSON.stringify(bad));
    await assert.rejects(() => readChatgptSnapshot(opts).next(), /Invalid/);
  }
  const clean = fixture("official-export-normalized");
  clean.conversation.branches_complete = true;
  clean.conversation.attachments_complete = true;
  clean.messages.forEach((m) => (m.truncated = false));
  await fs.writeFile(file, JSON.stringify(clean));
  const batches = [];
  for await (const batch of readChatgptSnapshot(opts)) batches.push(batch);
  assert.equal(batches[0].source.coverage.complete, true);
  assert.equal(batches[0].source.coverage.completenessScope, "normalized-file");
  assert.equal(batches[0].source.coverage.accountCoverage, "unverified");
  assert.equal(batches[0].source.representation, "official-export-normalized");
});

test("rejects unsafe files, invalid encodings and impossible timestamps without leaking input", async (t) => {
  const { spawnSync } = require("node:child_process");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-file-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json");
  const opts = {
    file,
    owner: "o",
    project: "p",
    instance: "i",
    session: "synthetic-thread",
  };
  const read = (fileName) =>
    readChatgptSnapshot({ ...opts, file: fileName }).next();
  await fs.writeFile(file, JSON.stringify(fixture()));
  const link = path.join(dir, "link");
  await fs.symlink(file, link);
  await assert.rejects(read(link));
  const fifo = path.join(dir, "fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  await assert.rejects(read(fifo), /not a file/);
  const tooLarge = path.join(dir, "large");
  const handle = await fs.open(tooLarge, "w");
  await handle.truncate(16 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(read(tooLarge), /file limit/);
  await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(read(file), /encoding or JSON/);
  await fs.writeFile(file, '{"secret":"SYNTHETIC_PRIVATE_MARKER",');
  await assert.rejects(
    read(file),
    (error) =>
      !error.message.includes("SYNTHETIC_PRIVATE_MARKER") &&
      /encoding or JSON/.test(error.message),
  );
  for (const timestamp of [
    "2026-02-30T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-13-01T00:00:00Z",
  ]) {
    const bad = fixture();
    bad.messages[0].created_at = timestamp;
    await fs.writeFile(file, JSON.stringify(bad));
    await assert.rejects(read(file), /Invalid/);
  }
  for (const key of ["id"]) {
    const bad = fixture();
    bad.conversation[key] = "   ";
    await fs.writeFile(file, JSON.stringify(bad));
    await assert.rejects(read(file), /Invalid/);
  }
  const bad = fixture();
  bad.messages[0].id = " \t";
  await fs.writeFile(file, JSON.stringify(bad));
  await assert.rejects(read(file), /Invalid/);
});

test("CLI import preserves the input and exposes only scrubbed source-only evidence", async (t) => {
  const { spawnSync } = require("node:child_process");
  const { createQuery } = require("../lib/query.cjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-cli-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json"),
    archiveDir = path.join(dir, "archive");
  const snapshot = fixture();
  snapshot.messages[0].text =
    "synthetic 1 token=fixture-secret /Users/synthetic/private.txt";
  const original = JSON.stringify(snapshot);
  await fs.writeFile(file, original, { mode: 0o600 });
  const args = [
    "bin/memory.cjs",
    "ingest",
    "--source",
    "chatgpt",
    "--file",
    file,
    "--instance",
    "fixture",
    "--session",
    "synthetic-thread",
    "--owner",
    "synthetic",
    "--project",
    "fixture",
    "--dir",
    archiveDir,
  ];
  const first = spawnSync(process.execPath, args, {
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).itemsImported, 3);
  const archive = await openArchive({ dir: archiveDir, readOnly: true });
  const rows = await archive.listItems({
    owner: "synthetic",
    project: "fixture",
  });
  const record = rows.find((row) => row.item.text?.startsWith("synthetic 1"));
  assert(record);
  const query = createQuery(archive);
  const evidence = await query.evidence({
    owner: "synthetic",
    project: "fixture",
    id: record.item.id,
    revision: record.versionId,
    source: record.source,
  });
  assert.equal(evidence.text, "synthetic 1 token=[REDACTED] [PRIVATE_PATH]");
  assert.equal(evidence.original.availability, "source-only");
  assert.equal(evidence.metadata.originalBytes, false);
  assert.equal(await fs.readFile(file, "utf8"), original);
  await assert.rejects(
    fs.stat(path.join(archiveDir, "originals")),
    (error) => error.code === "ENOENT",
  );
});

test("reads the opened file across path replacement and detects growth after fstat", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-race-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "snapshot.json"),
    saved = path.join(dir, "saved.json");
  await fs.writeFile(file, JSON.stringify(fixture()));
  const opts = {
    file,
    owner: "o",
    project: "p",
    instance: "i",
    session: "synthetic-thread",
  };
  const realOpen = fs.open;
  let openCount = 0;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await realOpen(...args);
    openCount++;
    await fs.rename(file, saved);
    await fs.writeFile(file, "not JSON");
    return handle;
  });
  const batches = [];
  for await (const batch of readChatgptSnapshot(opts)) batches.push(batch);
  assert.equal(batches[0].items.length, 3);
  assert.equal(openCount, 1);
  t.mock.restoreAll();
  await fs.rm(file);
  await fs.rename(saved, file);
  t.mock.method(fs, "open", async (...args) => {
    const handle = await realOpen(...args);
    const realStat = handle.stat.bind(handle);
    handle.stat = async () => {
      const result = await realStat();
      await fs.appendFile(file, Buffer.alloc(16 * 1024 * 1024));
      return result;
    };
    return handle;
  });
  await assert.rejects(() => readChatgptSnapshot(opts).next(), /file limit/);
  t.mock.restoreAll();
});
