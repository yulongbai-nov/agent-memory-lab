"use strict";
// Task state is a projection of immutable, explicitly linked observations.
const { canonical } = require("./storage.cjs");
const sourceKey = (s) => JSON.stringify([s.harness, s.instance, s.session]);
const rootKey = (r) => canonical(r);
const inScope = (a, b) =>
  a.scope.owner === b.owner && a.scope.project === b.project;
const fullRef = (r) =>
  r &&
  typeof r === "object" &&
  !Array.isArray(r) &&
  Object.keys(r).sort().join(",") === "id,revision,source" &&
  typeof r.id === "string" &&
  r.id.trim() &&
  typeof r.revision === "string" &&
  r.revision.trim() &&
  r.source &&
  typeof r.source === "object" &&
  !Array.isArray(r.source) &&
  Object.keys(r.source).sort().join(",") === "harness,instance,session" &&
  ["harness", "instance", "session"].every(
    (k) => typeof r.source[k] === "string" && r.source[k].trim(),
  );
const sameRef = (a, b) =>
  fullRef(a) &&
  fullRef(b) &&
  a.id === b.id &&
  a.revision === b.revision &&
  sourceKey(a.source) === sourceKey(b.source);
function resolveRef(rows, scope, ref) {
  if (!fullRef(ref)) throw Error("Exact source reference required");
  const r = rows.findVersion(scope, ref.id, ref.revision);
  if (!r || sourceKey(r.source) !== sourceKey(ref.source))
    throw Error("Task source not found");
  return r;
}
function resolveRoot(rows, scope, root) {
  if (!root || typeof root !== "object" || Array.isArray(root))
    throw Error("Invalid task root");
  if (
    root.kind === "annotation" &&
    Object.keys(root).sort().join(",") === "id,kind" &&
    typeof root.id === "string" &&
    root.id.trim()
  ) {
    const annotation = rows.getAnnotation(
      JSON.stringify([scope.owner, scope.project, root.id]),
    );
    if (!annotation || annotation.kind !== "todo")
      throw Error("Task review not found");
    const target = rows.findVersion(
      scope,
      annotation.target.id,
      annotation.target.revision,
    );
    if (!target) throw Error("Task target not found");
    if (
      annotation.target.source &&
      sourceKey(annotation.target.source) !== sourceKey(target.source)
    )
      throw Error("Task source mismatch");
    return {
      target: {
        id: target.item.id,
        revision: target.versionId,
        source: {
          harness: target.source.harness,
          instance: target.source.instance,
          session: target.source.session,
        },
      },
      annotation,
    };
  }
  if (
    root.kind === "source" &&
    Object.keys(root).sort().join(",") === "id,kind,revision,source"
  ) {
    const ref = { id: root.id, revision: root.revision, source: root.source },
      record = resolveRef(rows, scope, ref);
    if (
      record.item.metadata?.reviewed !== true ||
      record.item.metadata?.kind !== "todo"
    )
      throw Error("Legacy reviewed todo required");
    return { target: ref, record };
  }
  throw Error("Invalid task root");
}
function heads(observations) {
  const referenced = new Set(observations.flatMap((x) => x.parents));
  return observations
    .filter((x) => !referenced.has(x.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function validateTaskState(a, rows, { validTimestamp }) {
  const allowed = [
    "id",
    "scope",
    "owner",
    "project",
    "kind",
    "text",
    "target",
    "taskRoot",
    "parents",
    "state",
    "evidenceKind",
    "evidence",
    "recordedAt",
    "occurredAt",
  ];
  if (
    Object.keys(a).some((k) => !allowed.includes(k)) ||
    !["open", "paused", "completed", "cancelled"].includes(a.state) ||
    !["source", "operator"].includes(a.evidenceKind) ||
    !Array.isArray(a.parents) ||
    a.parents.some((x) => typeof x !== "string" || !x.trim() || x === a.id) ||
    new Set(a.parents).size !== a.parents.length ||
    !validTimestamp(a.recordedAt) ||
    (a.occurredAt !== undefined &&
      (!validTimestamp(a.occurredAt) ||
        Date.parse(a.occurredAt) > Date.parse(a.recordedAt)))
  )
    throw Error("Invalid task state");
  const root = resolveRoot(rows, a.scope, a.taskRoot);
  if (!sameRef(a.target, root.target)) throw Error("Task target mismatch");
  if (a.evidenceKind === "source") {
    const evidence = resolveRef(rows, a.scope, a.evidence);
    const type = evidence.item.metadata?.recordType || "";
    if (
      sameRef(a.evidence, a.target) ||
      evidence.item.kind !== "message" ||
      type === "turn/end" ||
      type.startsWith("turn/end:") ||
      [
        "event_msg:task_complete",
        "event_msg:turn_completed",
        "turn/completed",
      ].includes(type)
    )
      throw Error("Independent state evidence required");
  } else if (a.evidence !== undefined)
    throw Error("Operator observation cannot include source evidence");
  for (const id of a.parents) {
    const parent = rows.getAnnotation(
      JSON.stringify([a.scope.owner, a.scope.project, id]),
    );
    if (
      !parent ||
      parent.kind !== "task-state" ||
      rootKey(parent.taskRoot) !== rootKey(a.taskRoot)
    )
      throw Error("Invalid task parent");
  }
}
function checkNewParents(a, rows) {
  const all = rows
      .listAnnotations(a.scope)
      .filter(
        (x) =>
          x.kind === "task-state" &&
          rootKey(x.taskRoot) === rootKey(a.taskRoot),
      ),
    current = heads(all);
  if (all.length && a.parents.length === 0) throw Error("Task parent required");
  const states = new Set(current.map((x) => x.state));
  if (states.size > 1 && current.some((x) => !a.parents.includes(x.id)))
    throw Error("All conflict heads required");
}
function projection(root, observations, cancelled = false) {
  const relevant = observations.filter(
      (x) => x.kind === "task-state" && rootKey(x.taskRoot) === rootKey(root),
    ),
    current = heads(relevant),
    states = new Set(current.map((x) => x.state));
  let state = !current.length
    ? cancelled
      ? "cancelled"
      : "unmarked"
    : states.size === 1
      ? current[0].state
      : "conflict";
  return {
    state,
    label: {
      unmarked: "未标记结束",
      open: "未完成",
      paused: "已暂停",
      completed: "已完成",
      cancelled: "已取消",
      conflict: "状态冲突",
    }[state],
    heads: current.map((x) => ({
      id: x.id,
      state: x.state,
      text: x.text,
      evidenceKind: x.evidenceKind,
      evidenceLabel: x.evidenceKind === "operator" ? "操作员声明" : "来源证据",
      ...(x.evidence ? { evidence: x.evidence } : {}),
      recordedAt: x.recordedAt,
      occurredAt: x.occurredAt || null,
    })),
  };
}
module.exports = {
  validateTaskState,
  checkNewParents,
  projection,
  rootKey,
  inScope,
};
