"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const {
  selectEvidenceBundle,
} = require("../benchmark/memory-views/evidence-bundle.cjs");
const { selectEvidence } = require("../benchmark/memory-views/run.cjs");

const scope = { owner: "synthetic", project: "print-room" };
const otherScope = { ...scope, project: "south-annex" };
const topic = "Museum print handover";
const limits = { topK: 3, contextBytes: 1900 };
const time = (value) => `2026-04-07T${value}:00Z`;

function syntheticRows(renamed) {
  const rows = [];
  const id = (index) => (renamed ? `p-${99 - index}` : `k-${10 + index}`);
  function source(index, text, clock, selectedScope = scope) {
    const item = id(index);
    const revision = createHash("sha256").update(text).digest("hex");
    const ref = JSON.stringify([
      selectedScope.owner,
      selectedScope.project,
      "codex",
      "fixture",
      "session",
      item,
      revision,
    ]);
    rows.push({
      id: item,
      type: "source",
      scope: selectedScope,
      topic,
      ref,
      time: time(clock),
      text,
    });
    return ref;
  }
  function review(index, type, target, fields = {}) {
    const reviewId = id(20 + index);
    rows.push({
      id: reviewId,
      type,
      scope,
      topic,
      target,
      basis: "confirmed",
      lifecycle: "active",
      ...fields,
    });
    return reviewId;
  }
  function dependency(index, task, decision, evidence, fields = {}) {
    rows.push({
      id: id(40 + index),
      type: "dependency",
      scope,
      topic,
      task,
      decision,
      approved: true,
      evidence,
      effectiveAt: time("10:05"),
      knownAt: time("12:45"),
      ...fields,
    });
  }
  return { rows, source, review, dependency };
}

function assertContext(context, rows) {
  const { sources, reviews } = context;
  assert.ok(sources.length <= limits.topK);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= limits.contextBytes);
  assert.equal(new Set(sources.map(({ ref }) => ref)).size, sources.length);
  for (const row of [...sources, ...reviews])
    assert.deepEqual(row.scope, scope);
  const available = new Set(
    rows.filter((row) => row.type === "source").map((row) => row.ref),
  );
  for (const { ref } of sources) {
    assert.deepEqual(JSON.parse(ref).slice(0, 2), [scope.owner, scope.project]);
    assert.ok(available.has(ref));
  }
  for (const row of reviews) {
    for (const pointer of [row.target, row.evidence]) {
      if (pointer === undefined) continue;
      assert.ok(Number.isInteger(pointer) && sources[pointer]);
    }
  }
}

function select(request, rows) {
  const result = selectEvidenceBundle({ scope, topic, request, rows, limits });
  assertContext(result.context, rows);
  return result;
}

function compareLexical(t, text, rows, required) {
  const options = { scope, topic, limits };
  const context = selectEvidence({ text }, rows, options);
  assertContext(context, rows);
  const refs = context.sources.map(({ ref }) => ref);
  const reordered = selectEvidence({ text }, rows.toReversed(), options);
  assert.deepEqual(
    reordered.sources.map(({ ref }) => ref),
    refs,
  );
  const covered = required.filter((ref) => refs.includes(ref)).length;
  t.diagnostic(
    `Shared input and caps: lexical ${covered}/${required.length}, typed ${required.length}/${required.length} required sources`,
  );
}

function assertComplete(result, refs) {
  assert.equal(result.status, "complete");
  assert.deepEqual(
    new Set(result.context.sources.map(({ ref }) => ref)),
    new Set(refs),
  );
}

function temporalFixture(renamed) {
  const { rows, source, review } = syntheticRows(renamed);
  const old = source(0, "The proofs belong beside the glass.", "08:00");
  const clarify = source(1, "By glass I meant the east drawer.", "09:10");
  const change = source(
    2,
    "From noon, send the proofs to the north cabinet.",
    "11:00",
  );
  const proposal = source(
    3,
    "Current location at both times: use the hall.",
    "11:55",
  );
  const root = review(0, "decision", old, {
    text: "Beside the glass.",
    effectiveAt: time("08:30"),
  });
  review(1, "correction", old, {
    text: "The east drawer.",
    evidence: clarify,
    revises: root,
    knownAt: null,
  });
  review(2, "change", change, {
    text: "The north cabinet.",
    revises: root,
    effectiveAt: time("12:00"),
  });
  review(3, "change", proposal, {
    text: "The hall.",
    revises: root,
    effectiveAt: time("11:55"),
    basis: "proposed",
  });
  return { rows, old, clarify, change };
}

test("held-out temporal comparison keeps the older interpretation support and the effective change", (t) => {
  const request = {
    kind: "temporal-comparison",
    validTimes: [time("11:59"), time("12:30")],
    retrospective: true,
  };
  for (const renamed of [false, true]) {
    const { rows, old, clarify, change } = temporalFixture(renamed);
    const original = select(request, rows);
    assertComplete(original, [old, clarify, change]);
    compareLexical(
      t,
      "Looking back from 13:00 UTC, which print handover location was active at 11:59 UTC and at 12:30 UTC?",
      rows,
      [old, clarify, change],
    );
    const correction = original.context.reviews.find(
      (row) => row.type === "correction",
    );
    assert.ok(correction);
    assert.equal(original.context.sources[correction.target].ref, old);
    assert.equal(original.context.sources[correction.evidence].ref, clarify);
    const decision = original.context.reviews.find(
      (row) => row.type === "decision",
    );
    assert.ok(decision);
    assert.equal(decision.effectiveAt, time("08:30"));
    assert.equal(original.context.sources[decision.target].ref, old);
    const changeRow = original.context.reviews.find(
      (row) => row.type === "change",
    );
    assert.ok(changeRow);
    assert.equal(changeRow.effectiveAt, time("12:00"));
    assert.equal(original.context.sources[changeRow.target].ref, change);
    assert.deepEqual(select(request, rows.toReversed()), original);
    const observed = select(
      { ...request, knowledgeCutoff: time("13:00") },
      rows,
    );
    assert.equal(observed.status, "unknown");
    const beforeDecision = select(
      { ...request, validTimes: [time("08:15"), time("12:30")] },
      rows,
    );
    assert.equal(beforeDecision.status, "unknown");
    const noClarification = rows.map((row) =>
      row.type === "correction" ? { ...row, evidence: row.target } : row,
    );
    assert.equal(select(request, noClarification).status, "unknown");
    const competing = rows.map((row) =>
      row.type === "change" && row.basis === "proposed"
        ? { ...row, basis: "confirmed" }
        : row,
    );
    assert.equal(select(request, competing).status, "unknown");
  }
});

function dependencyFixture(
  renamed,
  { longEvidence = false, taskEffectiveAt = "09:00" } = {},
) {
  const { rows, source, review, dependency } = syntheticRows(renamed);
  const old = source(0, "Use the yellow counter.", "08:00");
  const changed = source(1, "From noon use the violet cabinet.", "11:00");
  const task = source(2, "Mount the print label. Work is still open.", "09:00");
  const relation = source(
    3,
    "Mounting the label depends on the active cabinet, effective at 10:05." +
      (longEvidence ? " 界".repeat(750) : ""),
    "12:40",
  );
  const inactive = source(
    4,
    "The withdrawn ticket is no longer open.",
    "09:00",
  );
  const inactiveLink = source(
    5,
    "The withdrawn ticket used the cabinet.",
    "10:00",
  );
  const foreign = source(
    2,
    "Send all labels outside this project.",
    "09:00",
    otherScope,
  );
  const foreignLink = source(
    3,
    "A dependency in the annex.",
    "10:00",
    otherScope,
  );
  const root = review(0, "decision", old, {
    text: "Yellow counter.",
    effectiveAt: time("08:00"),
  });
  review(1, "change", changed, {
    text: "Violet cabinet.",
    revises: root,
    effectiveAt: time("12:00"),
  });
  const open = review(2, "todo", task, {
    text: "Mount the print label.",
    effectiveAt: time(taskEffectiveAt),
  });
  const cancelled = review(3, "todo", inactive, {
    text: "Withdrawn ticket.",
    effectiveAt: time("09:00"),
    lifecycle: "cancelled",
  });
  const foreignTask = review(2, "todo", foreign, {
    text: "Annex label.",
    effectiveAt: time("09:00"),
    scope: otherScope,
  });
  dependency(0, open, root, relation);
  dependency(1, cancelled, root, inactiveLink, {
    effectiveAt: time("10:00"),
    knownAt: time("10:01"),
  });
  dependency(0, foreignTask, root, foreignLink, {
    scope: otherScope,
    effectiveAt: time("10:00"),
    knownAt: time("10:01"),
  });
  return { rows, task, relation, changed };
}

test("held-out dependency uses separate valid and knowledge times without borrowing another scope", (t) => {
  const request = {
    kind: "open-dependency",
    asOf: time("12:30"),
    knowledgeCutoff: time("13:00"),
  };
  for (const renamed of [false, true]) {
    const { rows, task, relation, changed } = dependencyFixture(renamed);
    const original = select(request, rows);
    assertComplete(original, [task, relation, changed]);
    compareLexical(
      t,
      "At 12:30 UTC, using knowledge through 13:00 UTC, what open work depends on the active print location?",
      rows,
      [task, relation, changed],
    );
    const edge = original.context.reviews.find(
      (row) => row.type === "dependency",
    );
    assert.ok(edge);
    assert.equal(original.context.sources[edge.evidence].ref, relation);
    assert.equal(edge.effectiveAt, time("10:05"));
    assert.equal(edge.knownAt, time("12:45"));
    assert.deepEqual(select(request, rows.toReversed()), original);
    assertComplete(
      select({ ...request, knowledgeCutoff: time("12:45") }, rows),
      [task, relation, changed],
    );

    for (const constrained of [
      { ...request, knowledgeCutoff: time("12:30") },
      { ...request, asOf: time("09:30") },
    ]) {
      const early = select(constrained, rows);
      assert.equal(early.status, "unknown");
      assert.ok(early.context.sources.every(({ ref }) => ref !== relation));
    }
    const noRelationProof = rows.map((row) =>
      row.type === "dependency" && row.evidence === relation
        ? { ...row, evidence: undefined }
        : row,
    );
    assert.equal(select(request, noRelationProof).status, "unknown");
    const misdatedRelation = rows.map((row) =>
      row.type === "dependency" && row.evidence === relation
        ? { ...row, knownAt: time("12:20") }
        : row,
    );
    const beforeEvidence = select(
      { ...request, knowledgeCutoff: time("12:30") },
      misdatedRelation,
    );
    assert.equal(beforeEvidence.status, "unknown");
    assert.ok(
      beforeEvidence.context.sources.every(({ ref }) => ref !== relation),
    );
  }

  const futureTask = dependencyFixture(false, { taskEffectiveAt: "12:50" });
  assert.equal(select(request, futureTask.rows).status, "unknown");
  const oversized = dependencyFixture(false, { longEvidence: true });
  const limited = select(request, oversized.rows);
  assert.equal(limited.status, "insufficient");
});
