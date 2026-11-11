"use strict";
// Bounded, read-only construction from supplied reviewed records; no answer oracle.
const stamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const empty = (status) => ({ status, context: { sources: [], reviews: [] } });
const sameScope = (a, b) => a?.owner === b?.owner && a?.project === b?.project;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function selectEvidenceBundle({
  scope,
  topic,
  request,
  rows,
  limits = { topK: 3, contextBytes: 1900 },
}) {
  if (
    !scope ||
    typeof scope.owner !== "string" ||
    !scope.owner ||
    typeof scope.project !== "string" ||
    !scope.project ||
    typeof topic !== "string" ||
    !topic ||
    !Array.isArray(rows) ||
    !request ||
    !Number.isSafeInteger(limits.topK) ||
    limits.topK < 1 ||
    limits.topK > 3 ||
    !Number.isSafeInteger(limits.contextBytes) ||
    limits.contextBytes < 1 ||
    limits.contextBytes > 1900
  )
    return empty("unknown");
  const scoped = rows.filter(
    (row) => row && sameScope(row.scope, scope) && row.topic === topic,
  );
  const sources = new Map();
  for (const row of scoped.filter((row) => row.type === "source")) {
    let ref;
    try {
      ref = JSON.parse(row.ref);
    } catch {
      return empty("unknown");
    }
    if (
      !Array.isArray(ref) ||
      ref.length !== 7 ||
      !ref.every((x) => typeof x === "string" && x) ||
      ref[0] !== scope.owner ||
      ref[1] !== scope.project ||
      sources.has(row.ref)
    )
      return empty("unknown");
    sources.set(row.ref, row);
  }
  const approved = scoped.filter(
    (row) =>
      ["decision", "change", "correction", "todo"].includes(row.type) &&
      row.basis === "confirmed" &&
      row.lifecycle === "active",
  );
  if (new Set(approved.map((row) => row.id)).size !== approved.length)
    return empty("unknown");
  const roots = approved.filter((row) => row.type === "decision");
  if (roots.length !== 1) return empty("unknown");
  const root = roots[0],
    corrections = approved.filter(
      (row) => row.type === "correction" && row.revises === root.id,
    ),
    changes = approved.filter(
      (row) => row.type === "change" && row.revises === root.id,
    );
  const revisionIds = new Set(
    [...changes, ...corrections].map((row) => row.id),
  );
  if (
    approved.some(
      (row) =>
        ["change", "correction"].includes(row.type) &&
        revisionIds.has(row.revises),
    )
  )
    return empty("unknown");
  const rootTime = root.effectiveAt ?? sources.get(root.target)?.time;
  if (!stamp(rootTime)) return empty("unknown");
  if (corrections.length > 1 || changes.some((row) => !stamp(row.effectiveAt)))
    return empty("unknown");
  function stateAt(time) {
    if (Date.parse(time) < Date.parse(rootTime)) return null;
    const eligible = changes.filter(
      (row) => Date.parse(row.effectiveAt) <= Date.parse(time),
    );
    // Multiple sibling heads have no recorded ordering relationship.
    if (eligible.length > 1) return null;
    return eligible[0] || corrections[0] || root;
  }
  let chosen;
  if (request.kind === "temporal-comparison") {
    if (
      request.retrospective !== true ||
      !Array.isArray(request.validTimes) ||
      request.validTimes.length !== 2 ||
      !request.validTimes.every(stamp) ||
      (request.knowledgeCutoff !== undefined && !stamp(request.knowledgeCutoff))
    )
      return empty("unknown");
    chosen = request.validTimes.map(stateAt);
    if (chosen.some((row) => !row)) return empty("unknown");
    // Include the original decision metadata used to establish the valid-time boundary.
    if (chosen.some((row) => row.type === "correction")) chosen.push(root);
    if (
      request.knowledgeCutoff !== undefined &&
      chosen.some(
        (row) =>
          !stamp(row.knownAt) ||
          Date.parse(row.knownAt) > Date.parse(request.knowledgeCutoff),
      )
    )
      return empty("unknown");
  } else if (request.kind === "open-dependency") {
    if (!stamp(request.asOf) || !stamp(request.knowledgeCutoff))
      return empty("unknown");
    const decision = stateAt(request.asOf);
    if (!decision) return empty("unknown");
    const relevantRelations = scoped.filter(
      (row) =>
        row.type === "dependency" &&
        row.approved === true &&
        row.decision === root.id &&
        approved.some((task) => {
          const effective = task.effectiveAt ?? sources.get(task.target)?.time;
          return (
            task.type === "todo" &&
            task.id === row.task &&
            stamp(effective) &&
            Date.parse(effective) <= Date.parse(request.asOf)
          );
        }),
    );
    if (
      relevantRelations.some((row) => {
        const evidenceTime = sources.get(row.evidence)?.time;
        return (
          !stamp(row.effectiveAt) ||
          !stamp(row.knownAt) ||
          !stamp(evidenceTime) ||
          Date.parse(row.knownAt) < Date.parse(evidenceTime)
        );
      })
    )
      return empty("unknown");
    const relations = relevantRelations.filter(
      (row) =>
        Date.parse(row.effectiveAt) <= Date.parse(request.asOf) &&
        Date.parse(row.knownAt) <= Date.parse(request.knowledgeCutoff),
    );
    if (relations.length !== 1) return empty("unknown");
    const relation = relations[0],
      tasks = approved.filter(
        (row) => row.type === "todo" && row.id === relation.task,
      );
    if (tasks.length !== 1) return empty("unknown");
    chosen = [decision, tasks[0], relation];
  } else return empty("unknown");
  if (
    chosen.some((row) => {
      if (row.type === "dependency")
        return typeof row.evidence !== "string" || !row.evidence;
      if (typeof row.target !== "string" || !row.target) return true;
      if (row.type === "correction")
        return (
          row.target !== root.target ||
          typeof row.evidence !== "string" ||
          !row.evidence ||
          row.evidence === row.target
        );
      return false;
    })
  )
    return empty("unknown");
  const seen = new Map();
  for (const row of chosen) {
    if (
      typeof row.id !== "string" ||
      !row.id ||
      (seen.has(row.id) && seen.get(row.id) !== row)
    )
      return empty("unknown");
    seen.set(row.id, row);
  }
  chosen = [...seen.values()].sort((a, b) => compare(a.id, b.id));
  const refs = [
    ...new Set(
      chosen.flatMap((row) => [row.target, row.evidence].filter(Boolean)),
    ),
  ].sort(compare);
  if (refs.some((ref) => !sources.has(ref))) return empty("unknown");
  // A recorded knowledge time cannot precede any source on which that review relies.
  if (
    chosen.some(
      (row) =>
        row.knownAt != null &&
        (!stamp(row.knownAt) ||
          [row.target, row.evidence].filter(Boolean).some((ref) => {
            const time = sources.get(ref)?.time;
            return !stamp(time) || Date.parse(row.knownAt) < Date.parse(time);
          })),
    )
  )
    return empty("unknown");
  const selected = refs.map((ref) => sources.get(ref));
  const context = {
    sources: selected.map(({ ref, time, text, scope }) => ({
      ref,
      time,
      text,
      scope,
    })),
    reviews: chosen.map((row) => ({
      scope: row.scope,
      id: row.id,
      type: row.type,
      ...(row.text != null && { text: row.text }),
      ...(row.target && { target: refs.indexOf(row.target) }),
      ...(row.evidence && { evidence: refs.indexOf(row.evidence) }),
      ...(row.revises && { revises: row.revises }),
      ...(row.task && { task: row.task }),
      ...(row.decision && { decision: row.decision }),
      ...(row.approved !== undefined && { approved: row.approved }),
      effectiveAt: row.effectiveAt ?? null,
      knownAt: row.knownAt ?? null,
      ...(row.basis && { basis: row.basis }),
      ...(row.lifecycle && { lifecycle: row.lifecycle }),
    })),
  };
  if (
    refs.length > limits.topK ||
    Buffer.byteLength(JSON.stringify(context)) > limits.contextBytes
  )
    return empty("insufficient");
  return { status: "complete", context };
}
module.exports = { selectEvidenceBundle };
