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
      {
        id: "relation",
        kind: "message",
        role: "user",
        text: "The checklist depends on the rehearsal slot.",
        time: "2026-01-01T10:05:00Z",
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
    task = await ref("task"),
    relation = await ref("relation");
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
        evidence: relation,
        quote: "depends on the rehearsal slot",
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
  assert.equal(result.tasks[0].relationEvidence.revision, relation.revision);
  assert.ok(!JSON.stringify(graph).includes("depends on the rehearsal slot"));
  assert.ok(!JSON.stringify(result).includes("depends on the rehearsal slot"));
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
  const currentKnown = answerDependency({
    projection: early,
    decisionRootId: "decision",
    mode: "current-known",
  });
  assert.equal(currentKnown.status, "resolved");
  assert.equal(currentKnown.decision.text, "Tuesday is rehearsal");
  assert.equal(
    currentKnown.decision.originalEvidence.revision,
    original.revision,
  );
  assert.equal(
    currentKnown.decision.effectiveEvidence.revision,
    correction.revision,
  );
  assert.equal(
    early.edges.some((e) => e.kind === "SUPERSEDES"),
    false,
  );
  assert.equal(
    early.revisions.some((e) => e.from === "change"),
    true,
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
    JSON.stringify({
      records: await a.listItems(scope),
      reviews: await a.listAnnotations(scope),
      dependencies,
    }),
  );
  const baseline = JSON.parse(await fs.readFile(file, "utf8"));
  const sourceFor = (r) =>
    baseline.records.find(
      (v) => v.item.id === r.target.id && v.versionId === r.target.revision,
    );
  const effective = (r) => r.valid_time || sourceFor(r)?.item.time;
  const selected = baseline.reviews
    .filter(
      (r) =>
        ["decision", "change"].includes(r.kind) &&
        r.topic === "Rehearsal" &&
        (r.basis || "confirmed") === "confirmed" &&
        effective(r) &&
        Date.parse(effective(r)) <= Date.parse(asOf),
    )
    .sort((x, y) => Date.parse(effective(y)) - Date.parse(effective(x)))[0];
  const todo = baseline.reviews.find(
    (r) =>
      r.kind === "todo" &&
      /checklist/i.test(sourceFor(r)?.item.text || "") &&
      baseline.dependencies.some((d) => d.approved && d.taskId === r.id),
  );
  assert.equal(selected.text, result.decision.text);
  assert.equal(
    sourceFor(selected).versionId,
    result.decision.evidence.revision,
  );
  assert.equal(todo.text, result.tasks[0].text);
  assert.equal(sourceFor(todo).versionId, result.tasks[0].evidence.revision);
  await assert.rejects(
    rebuildProjection({
      archive: a,
      scope,
      asOf,
      dependencies: [{ ...dependencies[0], quote: "not in source" }],
    }),
    /quote/,
  );
  await assert.rejects(
    rebuildProjection({
      archive: a,
      scope,
      asOf,
      dependencies: [dependencies[0], { ...dependencies[0], id: "another" }],
    }),
    /Duplicate dependency/,
  );
  await assert.rejects(
    rebuildProjection({
      archive: a,
      scope,
      asOf,
      dependencies: [
        { ...dependencies[0], evidence: { ...relation, revision: "missing" } },
      ],
    }),
    /Dangling/,
  );
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
test("inactive revisions without times stay structural and manual corrections do not invent evidence", async () => {
  const scope = { owner: "o", project: "p" },
    source = { harness: "h", instance: "i", session: "s" },
    asOf = "2026-01-01T12:00:00Z";
  const reference = (id) => ({ id, revision: "v-" + id, source });
  const records = new Map(
    ["root", "pending", "cancelled", "task", "relation"].map((id) => [
      id,
      {
        scope,
        source,
        versionId: "v-" + id,
        item: {
          id,
          ...(id === "root" ? { time: "2026-01-01T09:00:00Z" } : {}),
          ...(id === "relation"
            ? { text: "The task depends on the decision." }
            : {}),
        },
      },
    ]),
  );
  const rows = [
    {
      id: "decision",
      scope,
      kind: "decision",
      text: "Original",
      target: reference("root"),
    },
    {
      id: "pending",
      scope,
      kind: "change",
      text: "Pending",
      target: reference("pending"),
      revises: "decision",
      basis: "proposed",
    },
    {
      id: "cancelled",
      scope,
      kind: "change",
      text: "Cancelled",
      target: reference("cancelled"),
      revises: "decision",
      lifecycle: "cancelled",
    },
  ];
  const archive = {
    listAnnotations: async () => rows,
    getItem: async ({ id }) => records.get(id) || null,
  };
  const graph = await rebuildProjection({
    archive,
    scope,
    asOf,
    dependencies: [],
  });
  assert.equal(graph.revisions.length, 2);
  assert.equal(graph.edges.filter((e) => e.kind === "SUPERSEDES").length, 0);
  assert.equal(
    answerDependency({ projection: graph, decisionRootId: "decision" }).decision
      .text,
    "Original",
  );
  rows.push({
    id: "fix",
    scope,
    kind: "correction",
    text: "Manually corrected",
    target: reference("root"),
    revises: "decision",
  });
  const corrected = await rebuildProjection({
    archive,
    scope,
    asOf,
    dependencies: [],
  });
  assert.equal(
    answerDependency({ projection: corrected, decisionRootId: "decision" })
      .status,
    "ambiguous",
  );
  const current = answerDependency({
    projection: corrected,
    decisionRootId: "decision",
    mode: "current-known",
  });
  assert.equal(current.status, "resolved");
  assert.equal(current.decision.text, "Manually corrected");
  assert.equal(current.decision.originalEvidence.revision, "v-root");
  assert.equal(current.decision.effectiveEvidence, null);
  rows[3].evidence = reference("root");
  await assert.rejects(
    rebuildProjection({ archive, scope, asOf, dependencies: [] }),
    /not independent/,
  );
});
