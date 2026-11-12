"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readdir, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { openArchive } = require("../lib/archive.cjs");
const { runLocalDerive } = require("../lib/local-derive.cjs");
const originals = require("../lib/originals.cjs");
const { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");

const scope = { owner: "synthetic", project: "recovery" };
const otherScope = { owner: "synthetic", project: "other" };
const source = { harness: "dsh", instance: "fixture", session: "one" };
const oldTime = "2025-01-01T00:00:00Z";
const newTime = "2026-01-01T00:00:00Z";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "local-derive-recovery-"));
  let archive = await openArchive({ dir });
  t.after(async () => {
    archive.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  const capture = originals.originalCapture(dir);
  const positions = new Map();
  let coordinate = 0;
  return {
    dir,
    async message(id, turnId, text, time, role = "user") {
      const position = ++coordinate;
      const recordType = role + "/message";
      const original = await capture({
        coordinate: position,
        bytes: Buffer.from(
          JSON.stringify({
            type: recordType,
            data: { role, text },
          }) + "\n",
        ),
      });
      return {
        id,
        kind: "message",
        role,
        turnId,
        text,
        time,
        metadata: { recordType, coordinate: position, original },
      };
    },
    terminal(turnId, time, status = "completed") {
      return {
        id: "end-" + turnId + "-" + status,
        kind: "event",
        status,
        turnId,
        time,
        metadata: { recordType: "turn/end", coordinate: ++coordinate },
      };
    },
    async append(items, selectedScope = scope) {
      const previous = positions.get(selectedScope.project);
      const position = (previous ?? 0) + items.length;
      await archive.importBatch({
        scope: selectedScope,
        source,
        checkpoint: { ...(previous !== undefined && { previous }), position },
        items,
      });
      positions.set(selectedScope.project, position);
    },
    async migrate() {
      archive.close?.();
      await migrateJsonToSqlite({ dir });
      archive = await openArchive({ dir });
    },
    item(id) {
      return archive.getItem({ ...scope, source, id });
    },
    async drafts() {
      const folder = join(dir, "local-derive");
      const names = (await readdir(folder)).filter((name) =>
        name.endsWith(".txt"),
      );
      return Promise.all(
        names.map((name) => readFile(join(folder, name), "utf8")),
      );
    },
    async assertNoReviewWrites() {
      assert.deepEqual(await archive.listAnnotations(scope), []);
      assert.deepEqual(await archive.listAnnotations(otherScope), []);
    },
  };
}

test("a caught-up fence gives candidate work time despite continuous arrivals", async (t) => {
  const f = await fixture(t),
    text = "Next step: prepare the synthetic release checklist.",
    attempts = [];
  await f.append([
    await f.message("eligible", "eligible", text, oldTime),
    f.terminal("eligible", oldTime),
  ]);
  await f.migrate();
  const runner = {
      async prepareLocalModel() {
        return { fingerprint: "stub" };
      },
      async runLocalLlama({ prompt }) {
        const input = JSON.parse(prompt.split("\n").at(-1));
        attempts.push(input.map((x) => x.text));
        if (attempts.length < 4)
          throw Object.assign(Error("low"), {
            safeLocal: true,
            code: "MEMORY_ADMISSION",
            stats: { inferenceStarted: false },
          });
        return { output: '{"candidates":[]}', stats: {} };
      },
    },
    opts = { dir: f.dir, ...scope };
  let elapsed = 0,
    now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(performance, "now", () => {
    const value = elapsed;
    elapsed += 2500;
    return value;
  });
  for (let iteration = 0; iteration < 4; iteration++) {
    if (iteration) await f.append([f.terminal("noise-" + iteration, newTime)]);
    now += 86400000;
    elapsed = 0;
    const result = await runLocalDerive(opts, runner);
    if (iteration < 3) {
      assert.equal(result.reason, "MEMORY_ADMISSION");
      assert.equal(result.modelCalls, 0);
    } else {
      assert.equal(result.status, "validated");
      assert.equal(result.modelCalls, 1);
    }
    assert.equal(attempts.length, iteration + 1);
    assert.deepEqual(attempts[iteration], [text]);
  }
});

test("unfinished fixed fence returns before selection or runner", async (t) => {
  const f = await fixture(t),
    text = "Next step: prepare the synthetic checklist.",
    calls = [];
  await f.append([
    await f.message("eligible", "eligible", text, oldTime),
    f.terminal("eligible", oldTime),
    ...Array.from({ length: 120 }, (_, i) => f.terminal("noise-" + i, oldTime)),
  ]);
  await f.migrate();
  let elapsed = 0;
  t.mock.method(performance, "now", () => {
    const value = elapsed;
    elapsed += 2500;
    return value;
  });
  const runner = {
    async prepareLocalModel() {
      calls.push("prepare");
      return { fingerprint: "stub" };
    },
    async runLocalLlama() {
      calls.push("runner");
      return { output: '{"candidates":[]}', stats: {} };
    },
  };
  const result = await runLocalDerive({ dir: f.dir, ...scope }, runner);
  assert.equal(result.reason, "SCAN_CONTINUATION");
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(calls, []);
  const folder = join(f.dir, "local-derive"),
    name = (await readdir(folder)).find((x) => /^queue-.*\.sqlite$/.test(x)),
    { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(join(folder, name), { readOnly: true });
  const read = (k) => {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(k);
    return row ? JSON.parse(row.value) : null;
  };
  const progress = read("progress");
  assert.equal(progress.cursor, 100);
  assert.equal(progress.fence, 122);
  assert.equal(read("candidateProgress"), null);
  db.close();
});
