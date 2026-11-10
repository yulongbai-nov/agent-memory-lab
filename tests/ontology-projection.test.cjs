"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os");
const { openArchive } = require("../lib/archive.cjs"),
  { createQuery } = require("../lib/query.cjs");
const {
  rebuildProjection,
  answerDependency,
} = require("../lib/ontology-projection.cjs");
test("deterministic scoped projection answers a synthetic cross-harness dependency with exact evidence", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scope = { owner: "synthetic", project: "release" },
    a = await openArchive({ dir });
  t.after(() => a.close?.());
  const dsh = { harness: "dsh", instance: "one", session: "original" },
    clarification = {
      harness: "dsh",
      instance: "two",
      session: "clarification",
    },
    codex = { harness: "codex", instance: "one", session: "change" };
  await a.importBatch({
    scope,
    source: dsh,
    checkpoint: { position: 1 },
    items: [
      {
        id: "tuesday",
        kind: "message",
        role: "user",
        text: "Tuesday is the rehearsal slot.",
        time: "2026-01-01T09:00:00Z",
      },
      {
        id: "task",
        kind: "message",
        role: "user",
        text: "Prepare the checklist.",
        time: "2026-01-01T10:00:00Z",
      },
    ],
  });
  await a.importBatch({
    scope,
    source: clarification,
    checkpoint: { position: 1 },
    items: [
      {
        id: "clarify",
        kind: "message",
        role: "user",
        text: "That is rehearsal, not production.",
        time: "2026-01-01T09:05:00Z",
      },
    ],
  });
  await a.importBatch({
    scope,
    source: codex,
    checkpoint: { position: 1 },
    items: [
      {
        id: "wednesday",
        kind: "message",
        role: "user",
        text: "Move the rehearsal to Wednesday.",
        time: "2026-01-01T12:00:00Z",
      },
    ],
  });
  const ref = async (id) => {
    const v = await a.getItem({ ...scope, id });
    return { id, revision: v.versionId, source: v.source };
  };
  const original = await ref("tuesday"),
    correction = await ref("clarify"),
    changed = await ref("wednesday"),
    task = await ref("task");
  await a.addAnnotation({
    id: "decision",
    scope,
    kind: "decision",
    topic: "Rehearsal",
    text: "Tuesday",
    target: original,
  });
  await a.addAnnotation({
    id: "clarification",
    scope,
    kind: "correction",
    topic: "Rehearsal",
    text: "Tuesday is rehearsal",
    target: original,
    evidence: correction,
    revises: "decision",
  });
  await a.addAnnotation({
    id: "change",
    scope,
    kind: "change",
    topic: "Rehearsal",
    text: "Wednesday",
    target: changed,
    revises: "decision",
    valid_time: "2026-01-01T12:00:00Z",
  });
  await a.addAnnotation({
    id: "checklist",
    scope,
    kind: "todo",
    topic: "Rehearsal",
    text: "Prepare the checklist",
    target: task,
  });
  const dependencies = [
      {
        id: "dependency",
        scope,
        taskId: "checklist",
        decisionId: "decision",
        approved: true,
      },
    ],
    asOf = "2026-01-01T12:30:00Z";
  const graph = await rebuildProjection({
    archive: a,
    scope,
    asOf,
    dependencies,
  });
  assert.deepEqual(
    graph,
    await rebuildProjection({ archive: a, scope, asOf, dependencies }),
  );
  const result = answerDependency({
    projection: graph,
    decisionRootId: "decision",
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.decision.text, "Wednesday");
  assert.equal(result.decision.evidence.revision, changed.revision);
  assert.equal(result.tasks[0].text, "Prepare the checklist");
  assert.equal(result.tasks[0].evidence.revision, task.revision);
  assert.equal(graph.corrections[0].targetEvidence.revision, original.revision);
  assert.equal(graph.corrections[0].evidence.revision, correction.revision);
  assert.equal(graph.corrections[0].effectiveTimeKnown, false);
  const early = await rebuildProjection({
    archive: a,
    scope,
    asOf: "2026-01-01T11:00:00Z",
    dependencies,
  });
  assert.equal(
    answerDependency({ projection: early, decisionRootId: "decision" }).status,
    "ambiguous",
  );
  // Same fixture through the existing current query and a simple local file baseline; smoke only.
  const q = createQuery(a),
    current = await q.current({ ...scope, topic: "Rehearsal", asOf }),
    timeline = await q.timeline({ ...scope, topic: "Rehearsal" });
  assert.equal(current[0].text, result.decision.text);
  assert.equal(current[0].citation.revision, result.decision.evidence.revision);
  assert.ok(
    timeline.some(
      (row) =>
        row.review_id === "checklist" && row.next_step === result.tasks[0].text,
    ),
  );
  const file = path.join(dir, "synthetic-baseline.json");
  await fs.writeFile(
    file,
    JSON.stringify({ reviews: await a.listAnnotations(scope), dependencies }),
  );
  const baseline = JSON.parse(await fs.readFile(file, "utf8"));
  const selected = baseline.reviews.find((r) => r.id === "change");
  const todo = baseline.reviews.find(
    (r) => r.id === baseline.dependencies[0].taskId,
  );
  assert.equal(selected.text, result.decision.text);
  assert.equal(todo.text, result.tasks[0].text);
  await assert.rejects(
    rebuildProjection({
      archive: a,
      scope,
      asOf,
      dependencies: [{ ...dependencies[0], approved: false }],
    }),
    /unapproved/,
  );
  await assert.rejects(
    rebuildProjection({
      archive: a,
      scope,
      asOf,
      dependencies: [
        { ...dependencies[0], scope: { ...scope, project: "other" } },
      ],
    }),
    /cross-scope/,
  );
  await assert.rejects(
    rebuildProjection({
      archive: a,
      scope,
      asOf,
      dependencies: [{ ...dependencies[0], taskId: "absent" }],
    }),
    /Dangling/,
  );
});
test("rejects dangling, cross-scope, cyclic revisions and preserves concurrent uncertainty", async () => {
  const scope = { owner: "o", project: "p" },
    source = { harness: "h", instance: "i", session: "s" },
    asOf = "2026-01-01T12:30:00Z";
  const target = { id: "m", revision: "v", source },
    record = {
      scope,
      source,
      versionId: "v",
      item: { id: "m", time: "2026-01-01T09:00:00Z" },
    };
  const review = (id, kind, revises) => ({
    id,
    scope,
    kind,
    text: id,
    target,
    ...(revises ? { revises } : {}),
    topic: "T",
    valid_time: "2026-01-01T10:00:00Z",
  });
  const fake = (reviews) => ({
    listAnnotations: async () => reviews,
    getItem: async () => record,
  });
  await assert.rejects(
    rebuildProjection({
      archive: fake([review("c", "change", "missing")]),
      scope,
      asOf,
      dependencies: [],
    }),
    /Dangling/,
  );
  await assert.rejects(
    rebuildProjection({
      archive: fake([review("a", "change", "b"), review("b", "change", "a")]),
      scope,
      asOf,
      dependencies: [],
    }),
    /cycle/,
  );
  await assert.rejects(
    rebuildProjection({
      archive: {
        ...fake([review("a", "decision")]),
        getItem: async () => ({
          ...record,
          scope: { ...scope, project: "other" },
        }),
      },
      scope,
      asOf,
      dependencies: [],
    }),
    /cross-scope/,
  );
  const rows = [
    review("root", "decision"),
    review("one", "change", "root"),
    review("two", "change", "root"),
  ];
  const graph = await rebuildProjection({
    archive: fake(rows),
    scope,
    asOf,
    dependencies: [],
  });
  assert.deepEqual(
    graph,
    await rebuildProjection({
      archive: fake(rows.toReversed()),
      scope,
      asOf,
      dependencies: [],
    }),
  );
  assert.equal(
    answerDependency({ projection: graph, decisionRootId: "root" }).status,
    "ambiguous",
  );
  await assert.rejects(
    rebuildProjection({
      archive: fake(rows),
      scope,
      asOf: "2026-02-30T00:00:00Z",
      dependencies: [],
    }),
    /Invalid effective time/,
  );
  const manual = { ...review("fix", "correction", "root") };
  delete manual.valid_time;
  const corrected = await rebuildProjection({
    archive: fake([review("root", "decision"), manual]),
    scope,
    asOf,
    dependencies: [],
  });
  assert.equal(corrected.corrections[0].evidence, null);
  assert.equal(
    answerDependency({ projection: corrected, decisionRootId: "root" }).status,
    "ambiguous",
  );
});
