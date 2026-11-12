"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const { openArchive } = require("../lib/archive.cjs"),
  { createQuery } = require("../lib/query.cjs");
test("task observations retain exact state evidence and replay time", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-state-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const archive = await openArchive({ dir }),
    scope = { owner: "synthetic", project: "task" },
    source = { harness: "dsh", instance: "test", session: "one" };
  await archive.importBatch({
    scope,
    source,
    checkpoint: { position: 2 },
    items: [
      {
        id: "root",
        kind: "message",
        role: "user",
        text: "TODO: synthetic task",
        time: "2025-01-01T00:00:00Z",
      },
      {
        id: "done",
        kind: "message",
        role: "user",
        text: "Synthetic task is complete",
        time: "2025-01-02T00:00:00Z",
      },
    ],
  });
  const root = await archive.getItem({ ...scope, source, id: "root" }),
    done = await archive.getItem({ ...scope, source, id: "done" }),
    ref = (r) => ({ id: r.item.id, revision: r.versionId, source });
  await archive.addAnnotation({
    id: "review",
    scope,
    kind: "todo",
    text: "Synthetic task",
    target: ref(root),
  });
  const query = createQuery(archive);
  assert.equal((await query.taskList(scope)).tasks[0].state, "unmarked");
  const input = {
    id: "finish",
    scope,
    kind: "task-state",
    text: "Operator verified completion",
    taskRoot: { kind: "annotation", id: "review" },
    parents: [],
    state: "completed",
    evidenceKind: "source",
    target: ref(root),
    evidence: ref(done),
  };
  const first = await archive.addAnnotation(input),
    again = await archive.addAnnotation(input);
  assert.equal(first.recordedAt, again.recordedAt);
  assert.deepEqual(await archive.addAnnotation(first), first);
  assert.equal(first.occurredAt, undefined);
  await assert.rejects(
    archive.addAnnotation({
      ...input,
      id: "future",
      parents: ["finish"],
      occurredAt: new Date(Date.now() + 86400000).toISOString(),
    }),
    /Invalid task state/,
  );

  assert.equal((await query.taskList(scope)).tasks.length, 0);
  const timeline = await query.timeline(scope),
    todo = timeline.find((x) => x.review_id === "review");
  assert.equal(todo.next_step, null);
  assert.equal(todo.task_state.state, "completed");
  assert.deepEqual(todo.task_state.heads[0].evidence, ref(done));
  assert.equal(todo.task_state.heads[0].occurredAt, null);
  await assert.rejects(
    archive.addAnnotation({ ...input, text: "conflict" }),
    /conflict/i,
  );
  await assert.rejects(
    archive.addAnnotation({ ...input, id: "bad", parents: ["missing"] }),
    /parent/i,
  );
  await assert.rejects(
    archive.addAnnotation({ ...input, id: "same", evidence: ref(root) }),
    /independent/i,
  );
  archive.close?.();
});
test("pure projection preserves concurrent conflicts and explicit resolution", () => {
  const { projection } = require("../lib/task-state.cjs"),
    root = { kind: "annotation", id: "r" },
    mk = (id, state, parents) => ({
      id,
      kind: "task-state",
      taskRoot: root,
      state,
      parents,
      text: id,
      evidenceKind: "operator",
      recordedAt: "2026-01-01T00:00:00Z",
    }),
    a = mk("a", "open", []),
    b = mk("b", "completed", ["a"]),
    c = mk("c", "paused", ["a"]);
  assert.equal(projection(root, [a, b, c]).state, "conflict");
  assert.equal(
    projection(root, [a, b, c, mk("d", "open", ["b", "c"])]).state,
    "open",
  );
});

test("default MCP timeline returns only bounded task-state summary", () => {
  const { boundedTimeline } = require("../lib/mcp.cjs");
  const result = boundedTimeline({
    rows: [
      {
        text: "root",
        next_step: null,
        task_state: {
          state: "conflict",
          label: "状态冲突",
          heads: [
            {
              id: "h",
              evidenceKind: "operator",
              recordedAt: "2026-01-01T00:00:00.000Z",
              text: "private observation",
            },
          ],
        },
      },
    ],
    coverage: { total: 1 },
  });
  assert.deepEqual(result.rows[0].task_state, {
    view: "current-known",
    state: "conflict",
    label: "状态冲突",
    headCount: 1,
    heads: [
      {
        id: "h",
        evidenceKind: "operator",
        recordedAt: "2026-01-01T00:00:00.000Z",
        evidence: null,
      },
    ],
    truncated: false,
  });
  assert.equal(JSON.stringify(result).includes("private observation"), false);
  assert.equal(result.rows[0].next_step, null);
});

test("legacy task-list citation strips coverage and can be used as exact target", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "task-state-source-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const archive = await openArchive({ dir }),
    scope = { owner: "synthetic", project: "legacy" },
    source = { harness: "dsh", instance: "test", session: "one" };
  await archive.importBatch({
    scope,
    source: { ...source, coverage: { complete: true } },
    checkpoint: { position: 1 },
    items: [
      {
        id: "legacy",
        kind: "message",
        text: "Synthetic follow-up",
        metadata: { reviewed: true, kind: "todo" },
      },
    ],
  });
  const [task] = (await createQuery(archive).taskList(scope)).tasks;
  assert.deepEqual(task.target.source, source);
  await archive.addAnnotation({
    id: "paused",
    scope,
    kind: "task-state",
    text: "Paused by operator",
    taskRoot: task.root,
    target: task.target,
    parents: [],
    state: "paused",
    evidenceKind: "operator",
  });
  assert.equal(
    (await createQuery(archive).taskList(scope)).tasks[0].state,
    "paused",
  );
  archive.close?.();
});

test("MCP task evidence is whole, bounded across rows and reports omissions", () => {
  const { boundedTimeline } = require("../lib/mcp.cjs"),
    stamp = "2026-01-01T00:00:00.000Z",
    source = { harness: "dsh", instance: "i", session: "s" },
    make = (id) => ({
      id,
      evidenceKind: "source",
      recordedAt: stamp,
      evidence: { id: "item", revision: "a".repeat(64), source },
      text: "must not leak",
    });
  const four = [make("a"), make("b"), make("c"), make("d")],
    huge = {
      ...make("huge"),
      evidence: { id: "x".repeat(1001), revision: "a".repeat(64), source },
    };
  const rows = Array.from({ length: 30 }, () => ({
      next_step: null,
      task_state: {
        state: "paused",
        label: "已暂停",
        heads: four.concat(huge),
      },
    })),
    out = boundedTimeline({ rows });
  let total = 0;
  for (const row of out.rows) {
    assert.equal(row.task_state.headCount, 5);
    assert.equal(row.task_state.truncated, true);
    assert.equal(row.task_state.details, "本机 task-list 或 timeline");
    assert.ok(row.task_state.heads.length <= 3);
    for (const h of row.task_state.heads) {
      assert.deepEqual(h.evidence.source, source);
      assert.equal(h.evidence.id, "item");
      total += Buffer.byteLength(JSON.stringify(h)) + 1;
    }
  }
  assert.ok(total <= 4096);
  assert.equal(JSON.stringify(out).includes("must not leak"), false);
});
