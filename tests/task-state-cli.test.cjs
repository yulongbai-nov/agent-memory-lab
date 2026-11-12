"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const repo = path.resolve(
  process.env.TASK_STATE_REPO || path.join(__dirname, ".."),
);
const { openArchive } = require(path.join(repo, "lib/archive.cjs"));
const { canonical } = require(path.join(repo, "lib/storage.cjs"));
const wire = path.join(__dirname, "task-state-couch-wire.cjs");
const source = { harness: "dsh", instance: "synthetic", session: "task-demo" };
const date = "2026-03-05T09:00:00.000Z";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = JSON.stringify;
const review = (id) => ({ kind: "annotation", id });

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "task-state-cli-audit-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function client(dir, project = "task-state-audit") {
  const scope = { owner: "synthetic", project };
  function run(args, { wireStore, reject } = {}) {
    const env = { PATH: process.env.PATH, LANG: "C.UTF-8" };
    for (const key of ["TMPDIR", "NODE_PATH"])
      if (process.env[key]) env[key] = process.env[key];
    if (wireStore) {
      env.NODE_OPTIONS = `--require="${wire}"`;
      env.TASK_STATE_WIRE_STORE = wireStore;
    }
    const result = spawnSync(
      process.execPath,
      [
        path.join(repo, "bin/memory.cjs"),
        ...args,
        "--dir",
        dir,
        "--owner",
        scope.owner,
        "--project",
        scope.project,
      ],
      { env, encoding: "utf8", timeout: 15_000 },
    );
    assert.ifError(result.error);
    if (reject) {
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /Memory operation failed/);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { dir, scope, run };
}

async function readArchive(c, fn) {
  const archive = await openArchive({ dir: c.dir, readOnly: true });
  try {
    return await fn(archive);
  } finally {
    archive.close?.();
  }
}

const ref = (row) => ({
  id: row.item.id,
  revision: row.versionId,
  source: {
    harness: row.source.harness,
    instance: row.source.instance,
    session: row.source.session,
  },
});

async function find(c, predicate) {
  const row = await readArchive(c, async (db) =>
    (await db.listItems(c.scope)).find(predicate),
  );
  assert.ok(row);
  return ref(row);
}

async function nativeFixture(root, c) {
  const file = path.join(root, "native.jsonl");
  const rows = [
    {
      type: "session",
      version: 1,
      id: source.session,
      createdAt: date,
      cwd: "/synthetic/task-state",
      isSeeded: false,
      delegationDepth: 0,
    },
  ];
  let seq = 0;
  return async function append(turn, text) {
    for (const type of ["turn/start", "user/message", "turn/end"]) {
      seq++;
      rows.push({
        type,
        seq,
        time: new Date(Date.parse(date) + seq * 1000).toISOString(),
        data: {
          turn,
          ...(type === "user/message"
            ? { id: `user-${turn}`, role: "user", text }
            : {}),
        },
      });
    }
    await fs.writeFile(file, rows.map(json).join("\n") + "\n", { mode: 0o600 });
    c.run([
      "ingest",
      "--source",
      "dsh",
      "--file",
      file,
      "--instance",
      source.instance,
      "--session",
      source.session,
    ]);
    return find(c, (row) => row.item.text === text);
  };
}

function todo(c, id, target, text, ...options) {
  return c.run([
    "annotate",
    "--kind",
    "todo",
    "--id",
    id,
    "--target",
    json(target),
    "--text",
    text,
    ...options,
  ]);
}

function observe(
  c,
  {
    id,
    root,
    target,
    parents = [],
    state,
    text = state,
    evidenceKind = "operator",
    evidence,
    occurredAt,
  },
  reject,
) {
  return c.run(
    [
      "annotate",
      "--kind",
      "task-state",
      "--id",
      id,
      "--task-root",
      json(root),
      "--target",
      json(target),
      "--parents",
      json(parents),
      "--state",
      state,
      "--evidence-kind",
      evidenceKind,
      "--text",
      text,
      ...(evidence ? ["--evidence", json(evidence)] : []),
      ...(occurredAt ? ["--occurred-at", occurredAt] : []),
    ],
    { reject },
  );
}

const list = (c) => c.run(["task-list"]).tasks;
const rootIn = (c, root) =>
  list(c).find((x) => canonical(x.root) === canonical(root));
const timeline = (c) => c.run(["timeline", "--limit", "50"]).rows;
const timelineTask = (c, id) => timeline(c).find((x) => x.review_id === id);
const sync = (c, wireStore, mode) =>
  c.run(
    [
      "sync",
      "--couch-url",
      "http://127.0.0.1:5984/task-state-test",
      "--sync-mode",
      mode,
    ],
    { wireStore },
  );

function sourceFingerprint(c) {
  const db = new DatabaseSync(path.join(c.dir, "archive.sqlite3"), {
    readOnly: true,
  });
  try {
    return hash(
      json(
        db
          .prepare("SELECT version_id,data FROM versions ORDER BY version_id")
          .all(),
      ),
    );
  } finally {
    db.close();
  }
}

async function originalHashes(c) {
  const dir = path.join(c.dir, "originals");
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(dir))
        .sort()
        .map(async (name) => [
          name,
          hash(await fs.readFile(path.join(dir, name))),
        ]),
    ),
  );
}

test("actual CLI closes an annotated task only after explicit scoped evidence", async (t) => {
  const root = await fixture(t),
    c = client(path.join(root, "a"));
  const append = await nativeFixture(root, c),
    text = "下一步准备合成展签清单。";
  const target = await append("commitment", text),
    taskRoot = review("root-checklist");
  c.run(["migrate-index"]);
  todo(c, taskRoot.id, { id: target.id, revision: target.revision }, text);
  assert.deepEqual(rootIn(c, taskRoot).target, target);
  assert.equal(rootIn(c, taskRoot).state, "unmarked");
  assert.equal(rootIn(c, taskRoot).label, "未标记结束");
  const evidence = await append("completion", "合成展签清单已经准备完成。");
  const terminal = await find(
    c,
    (row) => row.item.status === "completed" && row.item.kind === "event",
  );
  assert.equal(timelineTask(c, taskRoot.id).next_step, text);
  const request = {
    id: "complete-checklist",
    root: taskRoot,
    target,
    state: "completed",
    evidenceKind: "source",
    evidence,
    text: "清单准备已完成。",
  };
  observe(c, { ...request, evidence: target }, true);
  observe(c, { ...request, evidence: terminal }, true);
  const versions = sourceFingerprint(c),
    originals = await originalHashes(c);
  const recorded = observe(c, request);
  assert.match(recorded.recordedAt, /Z$/);
  assert.equal(Object.hasOwn(recorded, "occurredAt"), false);
  assert.deepEqual(observe(c, request), recorded);
  assert.equal(rootIn(c, taskRoot), undefined);
  const historical = timelineTask(c, taskRoot.id);
  assert.equal(historical.text, text);
  assert.equal(historical.next_step, null);
  assert.equal(historical.task_state.state, "completed");
  assert.deepEqual(historical.task_state.heads[0].evidence, evidence);
  assert.equal(historical.task_state.heads[0].occurredAt, null);
  assert.equal(sourceFingerprint(c), versions);
  assert.deepEqual(await originalHashes(c), originals);
});

test("actual CLI scopes a legacy root by source and revision through pause, resume and cancellation", async (t) => {
  const root = await fixture(t),
    c = client(path.join(root, "legacy"));
  const archive = await openArchive({ dir: c.dir });
  const first = { ...source, session: "first" },
    second = { ...source, session: "second" };
  function legacy(text) {
    return {
      id: "shared-native-id",
      kind: "review",
      time: date,
      text,
      metadata: { reviewed: true, kind: "todo" },
    };
  }
  try {
    await archive.importBatch({
      scope: c.scope,
      source: first,
      checkpoint: { position: 1 },
      items: [legacy("旧版合成任务")],
    });
    await archive.importBatch({
      scope: c.scope,
      source: second,
      checkpoint: { position: 1 },
      items: [legacy("另一个会话的同名条目")],
    });
    await archive.importBatch({
      scope: c.scope,
      source: first,
      checkpoint: { previous: 1, position: 2 },
      items: [legacy("同一会话的新精确版本")],
    });
  } finally {
    archive.close?.();
  }
  c.run(["migrate-index"]);
  const target = await find(c, (r) => r.item.text === "旧版合成任务");
  const taskRoot = { kind: "source", ...target },
    before = sourceFingerprint(c);
  assert.equal(list(c).length, 3);
  todo(
    c,
    "legacy-cancelled-review",
    target,
    "仅取消这一审核根",
    "--lifecycle",
    "cancelled",
  );
  assert.equal(timelineTask(c, "legacy-cancelled-review").next_step, null);
  assert.equal(
    timelineTask(c, "legacy-cancelled-review").task_state.state,
    "cancelled",
  );
  const request = {
    id: "legacy-pause",
    root: taskRoot,
    target,
    state: "paused",
    text: "操作员声明暂停，等待后续核对。",
    occurredAt: date,
  };
  observe(c, { ...request, root: { ...taskRoot, source: second } }, true);
  observe(c, { ...request, evidence: target }, true);
  const paused = observe(c, request);
  assert.equal(paused.occurredAt, date);
  assert.ok(Date.parse(paused.recordedAt) > Date.parse(date));
  assert.equal(rootIn(c, taskRoot).state, "paused");
  assert.equal(rootIn(c, taskRoot).next_step, null);
  assert.equal(rootIn(c, taskRoot).heads[0].evidenceKind, "operator");
  const resumed = observe(c, {
    id: "legacy-resume",
    root: taskRoot,
    target,
    state: "open",
    parents: [paused.id],
  });
  assert.equal(rootIn(c, taskRoot).next_step, "旧版合成任务");
  observe(c, {
    id: "legacy-cancel",
    root: taskRoot,
    target,
    state: "cancelled",
    parents: [resumed.id],
  });
  assert.equal(rootIn(c, taskRoot), undefined);
  assert.equal(list(c).length, 2);
  assert.ok(list(c).every((row) => row.state === "unmarked"));
  assert.equal(sourceFingerprint(c), before);
  const notes = await readArchive(c, (db) => db.listAnnotations(c.scope));
  assert.deepEqual(
    notes.filter((x) => x.kind === "task-state").map((x) => x.id),
    ["legacy-pause", "legacy-resume", "legacy-cancel"],
  );
});

test("persistent CLI replicas converge and replay competing observations over a file-backed wire test", async (t) => {
  const root = await fixture(t),
    a = client(path.join(root, "a")),
    b = client(path.join(root, "b"));
  const wireStore = path.join(root, "wire");
  await fs.mkdir(wireStore, { mode: 0o700 });
  const append = await nativeFixture(root, a),
    target = await append("root", "准备合成检查项。");
  const evidence = await append("state", "合成检查项已完成。");
  a.run(["migrate-index"]);
  const conflict = review("root-conflict"),
    agree = review("root-agree");
  todo(a, conflict.id, target, "核对冲突任务");
  todo(a, agree.id, target, "核对同态并发任务");
  observe(a, { id: "seed-conflict", root: conflict, target, state: "open" });
  observe(a, { id: "seed-agree", root: agree, target, state: "open" });
  sync(a, wireStore, "all");
  sync(b, wireStore, "pull");
  b.run(["migrate-index"]);
  assert.deepEqual(list(a), list(b));
  // Subsequent ordinary CLI processes have no transport override or network URL.
  observe(a, {
    id: "a-completed",
    root: conflict,
    target,
    parents: ["seed-conflict"],
    state: "completed",
    evidenceKind: "source",
    evidence,
  });
  observe(b, {
    id: "b-paused",
    root: conflict,
    target,
    parents: ["seed-conflict"],
    state: "paused",
    occurredAt: date,
  });
  observe(a, {
    id: "a-agree",
    root: agree,
    target,
    parents: ["seed-agree"],
    state: "paused",
    text: "甲操作员声明暂停",
  });
  observe(b, {
    id: "b-agree",
    root: agree,
    target,
    parents: ["seed-agree"],
    state: "paused",
    text: "乙操作员声明暂停",
  });
  assert.equal(rootIn(a, conflict), undefined);
  assert.equal(rootIn(b, conflict).state, "paused");
  assert.equal(rootIn(a, agree).heads[0].id, "a-agree");
  assert.equal(rootIn(b, agree).heads[0].id, "b-agree");
  sync(a, wireStore, "all");
  sync(b, wireStore, "all");
  sync(a, wireStore, "pull");
  assert.deepEqual(list(a), list(b));
  const merged = rootIn(a, conflict);
  assert.equal(merged.state, "conflict");
  assert.equal(merged.next_step, null);
  assert.deepEqual(
    merged.heads.map((x) => x.id),
    ["a-completed", "b-paused"],
  );
  assert.equal(timelineTask(a, conflict.id).next_step, null);
  assert.equal(rootIn(a, agree).state, "paused");
  assert.deepEqual(
    rootIn(a, agree).heads.map((x) => x.text),
    ["甲操作员声明暂停", "乙操作员声明暂停"],
  );
  const resolution = {
    id: "resolve-conflict",
    root: conflict,
    target,
    state: "completed",
    evidenceKind: "source",
    evidence,
    text: "复核完成证据后结案",
  };
  observe(a, { ...resolution, parents: ["a-completed"] }, true);
  observe(a, { ...resolution, parents: ["b-agree"] }, true);
  observe(a, { ...resolution, parents: ["missing"] }, true);
  observe(client(a.dir, "other-scope"), { ...resolution, parents: [] }, true);
  observe(a, { ...resolution, parents: ["a-completed", "b-paused"] });
  observe(
    a,
    {
      ...resolution,
      parents: ["a-completed", "b-paused"],
      text: "同 ID 的另一条记录",
    },
    true,
  );
  sync(a, wireStore, "all");
  sync(b, wireStore, "pull");
  assert.deepEqual(list(a), list(b));
  assert.equal(rootIn(a, conflict), undefined);
  assert.equal(timelineTask(b, conflict.id).task_state.state, "completed");
  assert.equal(timelineTask(b, conflict.id).next_step, null);
  const reviews = (c) =>
    readArchive(c, async (db) =>
      (await db.listAnnotations(c.scope)).map(canonical).sort(),
    );
  assert.deepEqual(await reviews(a), await reviews(b));
  assert.equal(sourceFingerprint(a), sourceFingerprint(b));
  for (const c of [a, b]) {
    const replay = sync(c, wireStore, "all");
    assert.equal(replay.pushed, 0);
    assert.equal(replay.pulled, 0);
  }
});

test("actual task-list CLI pages results and bounds summaries without changing identifiers", async (t) => {
  const dir = await fixture(t),
    c = client(dir),
    append = await nativeFixture(dir, c),
    target = await append("page", "Synthetic pagination source");
  const db = await openArchive({ dir });
  try {
    for (let i = 0; i < 25; i++)
      await db.addAnnotation({
        scope: c.scope,
        id: "task-" + String(i).padStart(2, "0"),
        kind: "todo",
        text: "长".repeat(300),
        target,
      });
    const observation = {
      scope: c.scope,
      kind: "task-state",
      target,
      taskRoot: review("task-00"),
      state: "paused",
      evidenceKind: "operator",
      text: "长".repeat(300),
    };
    await db.addAnnotation({ ...observation, id: "base-page", parents: [] });
    for (let i = 0; i < 4; i++)
      await db.addAnnotation({
        ...observation,
        id: "head-" + i,
        parents: ["base-page"],
      });
    await db.addAnnotation({
      scope: c.scope,
      id: "z".repeat(2200),
      kind: "todo",
      text: "Long identifier task",
      target,
    });
  } finally {
    db.close?.();
  }
  const first = c.run(["task-list"]);
  assert.equal(first.tasks.length, 20);
  assert.deepEqual(first.coverage, {
    total: 26,
    offset: 0,
    limit: 20,
    has_more: true,
  });
  assert.ok(
    first.tasks.every(
      (x) => Buffer.byteLength(x.text) <= 512 && x.textTruncated === true,
    ),
  );
  assert.ok(first.tasks.every((x) => x.root.id.startsWith("task-")));
  const paused = first.tasks.find((x) => x.root.id === "task-00");
  assert.equal(paused.state, "paused");
  assert.equal(paused.next_step, null);
  assert.equal(paused.headCount, 4);
  assert.equal(paused.heads.length, 3);
  assert.equal(paused.headsTruncated, true);
  assert.ok(
    paused.heads.every(
      (x) => Buffer.byteLength(x.text) <= 256 && x.textTruncated === true,
    ),
  );

  const last = c.run(["task-list", "--offset", "20", "--limit", "100"]);
  assert.equal(last.tasks.length, 6);
  assert.equal(last.coverage.limit, 50);
  assert.equal(last.coverage.has_more, false);
  const oversized = last.tasks.find((x) => x.referencesOmitted);
  assert.ok(oversized);
  assert.equal("root" in oversized, false);
  assert.equal("target" in oversized, false);
  assert.equal(oversized.details, "本机 timeline");
  assert.deepEqual(
    c.run(["task-list", "--offset", "0", "--limit", "1"]).coverage,
    { total: 26, offset: 0, limit: 1, has_more: true },
  );
});
