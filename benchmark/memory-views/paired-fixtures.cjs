"use strict";
const { createHash } = require("node:crypto");
const scope = { owner: "synthetic", project: "print-room" };
const otherScope = { ...scope, project: "south-annex" };
const topic = "Museum print handover";
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

module.exports = { scope, topic, time, temporalFixture, dependencyFixture };
