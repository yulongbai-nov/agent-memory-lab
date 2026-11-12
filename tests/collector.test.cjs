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

test("collector persists fair pending work across fresh arrivals and retries", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "collector-fifo-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "source"),
    dir = path.join(tmp, "private");
  await fs.mkdir(root);
  await fs.mkdir(dir, { mode: 0o700 });
  const initial = ["a", "b", "c"].map((name) =>
    path.join(root, `${name}.jsonl`),
  );
  for (const file of initial) await fs.writeFile(file, "baseline");
  const resolvedInitial = await Promise.all(
    initial.map((file) => fs.realpath(file)),
  );
  const op = { scope: { owner: "synthetic", project: "p" }, archive: { dir } },
    input = { root, source: "codex", instance: "i", "max-sessions": 1 };
  const attempts = [];
  let outcome = "success";
  const ingest = async (_op, item) => {
    attempts.push(item.file);
    if (outcome === "fail") throw Error("synthetic failure");
    if (outcome === "partial") return { partial: true, progressed: true };
    if (outcome === "blocked") return { partial: true, progressed: false };
    return { itemsImported: 1 };
  };
  assert.equal((await collectChanged(op, input, ingest)).baseline, true);
  assert.deepEqual(attempts, []);
  const stateFile = path.join(
    dir,
    (await fs.readdir(dir)).find(
      (name) => name.startsWith("collector-") && name.endsWith(".json"),
    ),
  );
  // A pre-queue v1 state must remain usable without creating a new baseline.
  const oldState = JSON.parse(await fs.readFile(stateFile, "utf8"));
  delete oldState.pendingQueue;
  await fs.writeFile(stateFile, JSON.stringify(oldState));
  for (const file of initial) await fs.appendFile(file, " changed");
  outcome = "fail";
  assert.equal((await collectChanged(op, input, ingest)).sessionsFailed, 1);
  const first = attempts[0];
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.ok(Array.isArray(state.pendingQueue));
  assert.ok(state.pendingQueue.every((id) => /^[a-f0-9]{64}$/.test(id)));
  assert.ok(!JSON.stringify(state).includes(root));
  // Change mtimes after admission and add fresh work on every scan.
  const future = new Date("2035-01-01T00:00:00Z");
  await fs.utimes(first, future, future);
  for (let i = 0; i < 2; i++) {
    await fs.writeFile(path.join(root, `fresh-${i}.jsonl`), "new");
    outcome = i === 0 ? "partial" : "success";
    await collectChanged(op, input, ingest);
  }
  assert.deepEqual(new Set(attempts.slice(0, 3)), new Set(resolvedInitial));
  // The failed item rotates behind the other admitted work; a blocked signature
  // is not retried until the file changes.
  outcome = "blocked";
  while (!attempts.slice(3).includes(first) && attempts.length < 10)
    await collectChanged(op, input, ingest);
  assert.ok(attempts.slice(3).includes(first));
  const count = attempts.filter((file) => file === first).length;
  outcome = "success";
  for (let i = 0; i < 5; i++) await collectChanged(op, input, ingest);
  assert.equal(attempts.filter((file) => file === first).length, count);
  await fs.appendFile(first, " changed again");
  for (
    let i = 0;
    i < 5 && attempts.filter((file) => file === first).length === count;
    i++
  )
    await collectChanged(op, input, ingest);
  assert.equal(attempts.filter((file) => file === first).length, count + 1);
});

test("incomplete scans retain tracked work and report queue capacity overflow", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "collector-overflow-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "source"),
    dir = path.join(tmp, "private"),
    hidden = path.join(root, "unreadable");
  await fs.mkdir(root);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(root, "baseline.jsonl"), "baseline");
  const op = {
      scope: { owner: "synthetic", project: "capacity" },
      archive: { dir },
    },
    input = { root, source: "codex", instance: "i", "max-sessions": 1 };
  const ingest = async () => ({ itemsImported: 1 });
  await collectChanged(op, input, ingest);
  const stateFile = path.join(
    dir,
    (await fs.readdir(dir)).find(
      (name) => name.startsWith("collector-") && name.endsWith(".json"),
    ),
  );
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  for (let i = 0; i < 19999; i++)
    state.entries[i.toString(16).padStart(64, "0")] = { sig: "synthetic" };
  const unseen = "0".repeat(64);
  // An older binary can add entries without updating the saved order.
  state.pendingQueue = [unseen, "f".repeat(64)];
  await fs.writeFile(stateFile, JSON.stringify(state));
  await fs.mkdir(hidden);
  await fs.chmod(hidden, 0);
  t.after(() => fs.chmod(hidden, 0o700).catch(() => {}));
  await fs.writeFile(path.join(root, "new.jsonl"), "new");
  const result = await collectChanged(op, input, ingest);
  if (!result.inaccessible)
    return t.skip("filesystem permits reading a mode-000 directory");
  assert.equal(result.queueOverflow, 1);
  assert.equal(result.sessionsAttempted, 0);
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(Object.keys(saved.entries).length, 20000);
  assert.ok(Object.hasOwn(saved.entries, unseen));
  assert.deepEqual(saved.pendingQueue, [unseen]);
  await fs.chmod(hidden, 0o700);
  const recovered = await collectChanged(op, input, ingest);
  assert.equal(recovered.sessionsAttempted, 1);
  assert.equal(recovered.queueOverflow, undefined);
  assert.deepEqual(
    JSON.parse(await fs.readFile(stateFile, "utf8")).pendingQueue,
    [],
  );
});
