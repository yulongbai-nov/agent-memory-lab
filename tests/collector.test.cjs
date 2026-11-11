"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { collectChanged } = require("../lib/collector.cjs");
test("collector baselines, detects changes, retries failures and resumes partial work", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "collector-test-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "source"),
    dir = path.join(tmp, "private");
  await fs.mkdir(root);
  await fs.mkdir(dir, { mode: 0o700 });
  const a = path.join(root, "a.jsonl"),
    b = path.join(root, "b.jsonl");
  await fs.writeFile(a, "a");
  const op = { scope: { owner: "o", project: "p" }, archive: { dir } },
    input = { root, source: "codex", instance: "i", "max-sessions": "1" };
  let calls = 0,
    fail = false,
    partial = false,
    progress = true;
  const ingest = async () => {
    calls++;
    if (fail) {
      fail = false;
      throw Error("synthetic");
    }
    return { itemsImported: 1, partial, progressed: progress };
  };
  assert.equal((await collectChanged(op, input, ingest)).baseline, true);
  assert.equal(calls, 0);
  await collectChanged(op, input, ingest);
  assert.equal(calls, 0);
  await fs.appendFile(a, "x");
  fail = true;
  assert.equal((await collectChanged(op, input, ingest)).sessionsFailed, 1);
  partial = true;
  assert.equal((await collectChanged(op, input, ingest)).sessionsAttempted, 1);
  assert.equal((await collectChanged(op, input, ingest)).sessionsAttempted, 1);
  progress = false;
  assert.equal((await collectChanged(op, input, ingest)).sessionsAttempted, 1);
  assert.equal((await collectChanged(op, input, ingest)).sessionsAttempted, 0);
  await fs.appendFile(a, "z");
  partial = false;
  await collectChanged(op, input, ingest);
  await fs.writeFile(b, "new");
  assert.equal((await collectChanged(op, input, ingest)).sessionsAttempted, 1);
  await fs.appendFile(a, "again");
  await fs.writeFile(
    path.join(dir, "historical-backfill-pass-v1.json.lock"),
    "",
  );
  assert.equal(
    (await collectChanged(op, input, ingest)).skippedForBackfill,
    true,
  );
  await fs.rm(path.join(dir, "historical-backfill-pass-v1.json.lock"));
  await fs.writeFile(path.join(dir, "archive.json"), Buffer.alloc(1024 * 1024));
  assert.equal(
    (await collectChanged(op, { ...input, "max-archive-mib": 1 }, ingest))
      .skippedForCapacity,
    true,
  );
  const state = await fs.readFile(
    path.join(
      dir,
      (await fs.readdir(dir)).find(
        (x) => x.startsWith("collector-") && x.endsWith(".json"),
      ),
    ),
    "utf8",
  );
  assert.ok(!state.includes(root));
  assert.ok(!state.includes(".jsonl"));
});
test("watch routes incremental sessions to capture new records after baseline", async (t) => {
  const { execFileSync } = require("node:child_process");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "collector-cli-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "source"),
    dir = path.join(tmp, "private"),
    manifest = path.join(tmp, "manifest.json");
  await fs.mkdir(root);
  await fs.mkdir(dir, { mode: 0o700 });
  const file = path.join(root, "one.jsonl");
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "message",
      payload: { role: "user", content: "synthetic first" },
    }) + "\n",
  );
  await fs.writeFile(
    manifest,
    JSON.stringify([
      {
        root,
        source: "codex",
        instance: "i",
        incremental: true,
        "max-sessions": "3",
        "max-records": "40",
      },
    ]),
  );
  const run = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(__dirname, "../bin/memory.cjs"),
          "watch",
          "--manifest",
          manifest,
          "--dir",
          dir,
          "--owner",
          "o",
          "--project",
          "p",
          "--runs",
          "1",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ),
    );
  assert.equal(run().collector.baselines, 1);
  assert.equal(run().collector.sessionsAttempted, 0);
  await fs.appendFile(
    file,
    JSON.stringify({
      type: "message",
      payload: { role: "user", content: "synthetic second" },
    }) + "\n",
  );
  const result = run();
  assert.equal(result.collector.sessionsAttempted, 1);
  assert.ok(result.collector.itemsImported >= 1);
});
test("collector accepts v1 state and rejects malformed entry fields", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "collector-state-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "source"),
    dir = path.join(tmp, "archive");
  await fs.mkdir(root);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(root, "one.jsonl"), "synthetic");
  const op = { scope: { owner: "o", project: "p" }, archive: { dir } };
  const input = { root, source: "codex", instance: "i" };
  const ingest = async () => ({ itemsImported: 1 });
  await collectChanged(op, input, ingest);
  const file = path.join(
    dir,
    (await fs.readdir(dir)).find(
      (name) => name.startsWith("collector-") && name.endsWith(".json"),
    ),
  );
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  const entry = Object.values(state.entries)[0];
  Object.assign(entry, {
    attemptedAt: 1,
    partial: false,
    extraLegacyField: "preserved",
  });
  await fs.writeFile(file, JSON.stringify(state));
  assert.equal((await collectChanged(op, input, ingest)).sessionsAttempted, 0);
  entry.attemptedAt = "invalid";
  await fs.writeFile(file, JSON.stringify(state));
  await assert.rejects(
    collectChanged(op, input, ingest),
    /Invalid collector state/,
  );
});
