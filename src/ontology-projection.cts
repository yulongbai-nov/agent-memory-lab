"use strict";

// A rebuildable view over scoped, explicitly reviewed archive records.
type Scope = { owner: string; project: string };
type Source = { harness: string; instance: string; session: string };
type Citation = { id: string; revision: string; source?: Source };
type SourceRevision = {
  scope: Scope;
  id: string;
  revision: string;
  source: Source;
};
type Version = {
  scope: Scope;
  source: Source;
  versionId: string;
  item: {
    id: string;
    text?: string;
    time?: string;
    timestamp?: string;
    truncated?: unknown;
    preview?: unknown;
    metadata?: {
      truncated?: unknown;
      preview?: unknown;
      isPreview?: unknown;
      incomplete?: unknown;
      complete?: unknown;
    };
  };
};
type Review = {
  id: string;
  scope: Scope;
  kind: string;
  text: string;
  target: Citation;
  evidence?: Citation;
  revises?: string;
  topic?: string;
  basis?: string;
  lifecycle?: string;
  valid_time?: string;
};
type Dependency = {
  id: string;
  scope: Scope;
  taskId: string;
  decisionId: string;
  approved: true;
  evidence: Citation;
  quote?: string;
  effectiveAt?: string;
  knownAt?: string;
};
type Node = {
  id: string;
  kind: "decision" | "change" | "todo";
  text: string;
  topic: string;
  basis: string;
  lifecycle: string;
  effectiveAt: string | null;
  evidence: SourceRevision;
};
type Edge = {
  kind: "CORRECTS" | "SUPERSEDES" | "DEPENDS_ON";
  id: string;
  from: string;
  to: string;
  evidence?: SourceRevision;
  effectiveAt?: string | null;
  evidenceAt?: string | null;
  knownAt?: string | null;
  effectiveAtBasis?: "explicit" | "evidence-time" | "unknown";
};
type Projection = {
  scope: Scope;
  asOf: string;
  nodes: Node[];
  edges: Edge[];
  revisions: {
    from: string;
    to: string;
    evidence: SourceRevision;
    effectiveAt: string | null;
    basis: string;
    lifecycle: string;
  }[];
  corrections: {
    id: string;
    target: string;
    text: string;
    targetEvidence: SourceRevision;
    evidence: SourceRevision | null;
    effectiveTimeKnown: false;
  }[];
};
type Archive = {
  listAnnotations: (scope: Scope) => Promise<Review[]>;
  getItem: (
    args: Scope & { id: string; revision: string; source?: Source },
  ) => Promise<Version | null>;
};
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const sameScope = (a: Scope, b: Scope) =>
  a.owner === b.owner && a.project === b.project;
const timestamp = (value: string): number => {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!m) throw new Error("Invalid effective time");
  const year = Number(m[1]),
    month = Number(m[2]),
    day = Number(m[3]),
    hour = Number(m[4]),
    minute = Number(m[5]),
    second = Number(m[6]),
    zone = m[7] || "";
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] || 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  )
    throw new Error("Invalid effective time");
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error("Invalid effective time");
  return n;
};
const byId = <T extends { id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
async function rebuildProjection({
  archive,
  scope,
  asOf,
  dependencies,
}: {
  archive: Archive;
  scope: Scope;
  asOf: string;
  dependencies: Dependency[];
}): Promise<Projection> {
  if (!scope || !nonempty(scope.owner) || !nonempty(scope.project))
    throw new Error("Invalid scope");
  const at = timestamp(asOf);
  if (!Array.isArray(dependencies))
    throw new Error("Dependency sidecar required");
  const reviews = await archive.listAnnotations(scope);
  if (!Array.isArray(reviews)) throw new Error("Invalid reviews");
  const ids = new Set<string>();
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const corrections: Projection["corrections"] = [];
  const revisions: Projection["revisions"] = [];
  const relevant = reviews
    .filter((r) =>
      ["decision", "change", "todo", "correction"].includes(r.kind),
    )
    .sort(byId);
  for (const r of relevant) {
    if (
      !r ||
      !sameScope(r.scope, scope) ||
      !nonempty(r.id) ||
      !nonempty(r.text) ||
      ids.has(r.id)
    )
      throw new Error("Invalid or cross-scope review");
    ids.add(r.id);
  }
  async function resolve(
    ref: Citation,
  ): Promise<{ ref: SourceRevision; version: Version }> {
    if (!ref || !nonempty(ref.id) || !nonempty(ref.revision))
      throw new Error("Exact source revision required");
    if (
      ref.source &&
      (!nonempty(ref.source.harness) ||
        !nonempty(ref.source.instance) ||
        !nonempty(ref.source.session))
    )
      throw new Error("Invalid source");
    const version = await archive.getItem({
      ...scope,
      id: ref.id,
      revision: ref.revision,
      ...(ref.source ? { source: ref.source } : {}),
    });
    if (
      !version ||
      !sameScope(version.scope, scope) ||
      version.item.id !== ref.id ||
      version.versionId !== ref.revision ||
      !version.source ||
      !nonempty(version.source.harness) ||
      !nonempty(version.source.instance) ||
      !nonempty(version.source.session)
    )
      throw new Error("Dangling or cross-scope source revision");
    const item = version.item,
      meta = item.metadata;
    const marked = (value: unknown) =>
      value !== undefined && value !== null && value !== false;
    if (
      !nonempty(item.text) ||
      marked(item.truncated) ||
      marked(item.preview) ||
      marked(meta?.truncated) ||
      marked(meta?.isPreview) ||
      marked(meta?.incomplete) ||
      meta?.complete === false ||
      marked(meta?.preview)
    )
      throw new Error("Evidence text missing or incomplete");
    if (
      ref.source &&
      (ref.source.harness !== version.source.harness ||
        ref.source.instance !== version.source.instance ||
        ref.source.session !== version.source.session)
    )
      throw new Error("Source mismatch");
    return {
      ref: {
        scope: { ...scope },
        id: ref.id,
        revision: ref.revision,
        source: {
          harness: version.source.harness,
          instance: version.source.instance,
          session: version.source.session,
        },
      },
      version,
    };
  }
  const refs = new Map<string, SourceRevision>();
  for (const r of relevant) {
    const target = await resolve(r.target);
    refs.set(r.id, target.ref);
    if (r.kind === "correction") continue;
    if (r.kind !== "decision" && r.kind !== "change" && r.kind !== "todo")
      throw new Error("Invalid review kind");
    const effectiveAt =
      r.valid_time ||
      target.version.item.time ||
      target.version.item.timestamp ||
      null;
    if (effectiveAt !== null) timestamp(effectiveAt);
    if (r.basis && !["confirmed", "proposed", "uncertain"].includes(r.basis))
      throw new Error("Invalid basis");
    if (
      r.lifecycle &&
      !["active", "cancelled", "superseded"].includes(r.lifecycle)
    )
      throw new Error("Invalid lifecycle");
    nodes.push({
      id: r.id,
      kind: r.kind,
      text: r.text,
      topic: r.topic || "",
      basis: r.basis || "confirmed",
      lifecycle: r.lifecycle || "active",
      effectiveAt,
      evidence: target.ref,
    });
  }
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const r of relevant) {
    if (r.kind !== "change" && r.kind !== "correction") continue;
    if (!nonempty(r.revises) || r.revises === r.id)
      throw new Error("Explicit revision required");
    const prior = nodeMap.get(r.revises);
    if (!prior || !["decision", "change"].includes(prior.kind))
      throw new Error("Dangling revision");
    if (r.topic && prior.topic && r.topic !== prior.topic)
      throw new Error("Revision topic mismatch");
    const target = refs.get(r.id);
    if (!target) throw new Error("Missing source revision");
    if (r.kind === "correction") {
      if (
        target.id !== prior.evidence.id ||
        target.revision !== prior.evidence.revision
      )
        throw new Error("Correction target mismatch");
      const evidence = r.evidence ? (await resolve(r.evidence)).ref : null;
      if (
        evidence &&
        evidence.id === target.id &&
        evidence.revision === target.revision &&
        evidence.source.harness === target.source.harness &&
        evidence.source.instance === target.source.instance &&
        evidence.source.session === target.source.session
      )
        throw new Error("Correction evidence is not independent");
      corrections.push({
        id: r.id,
        target: prior.id,
        text: r.text,
        targetEvidence: target,
        evidence,
        effectiveTimeKnown: false,
      });
      edges.push({
        kind: "CORRECTS",
        id: r.id,
        from: r.id,
        to: prior.id,
        ...(evidence ? { evidence } : {}),
      });
    } else {
      const change = nodeMap.get(r.id);
      if (!change) throw new Error("Missing change");
      if (
        change.effectiveAt &&
        prior.effectiveAt &&
        timestamp(change.effectiveAt) < timestamp(prior.effectiveAt)
      )
        throw new Error("Revision precedes target");
      revisions.push({
        from: change.id,
        to: prior.id,
        evidence: change.evidence,
        effectiveAt: change.effectiveAt,
        basis: change.basis,
        lifecycle: change.lifecycle,
      });
      if (
        change.basis === "confirmed" &&
        change.lifecycle === "active" &&
        change.effectiveAt &&
        timestamp(change.effectiveAt) <= at &&
        prior.basis === "confirmed" &&
        prior.lifecycle === "active" &&
        prior.effectiveAt &&
        timestamp(prior.effectiveAt) <= at
      ) {
        edges.push({
          kind: "SUPERSEDES",
          id: r.id,
          from: r.id,
          to: prior.id,
          evidence: change.evidence,
          effectiveAt: change.effectiveAt,
        });
      }
    }
  }
  const parent = new Map(revisions.map((e) => [e.from, e.to]));
  for (const node of nodes) {
    const seen = new Set<string>();
    let cursor: string | undefined = node.id;
    while (cursor && parent.has(cursor)) {
      if (seen.has(cursor)) throw new Error("Revision cycle");
      seen.add(cursor);
      cursor = parent.get(cursor);
    }
  }
  const dependencyIds = new Set<string>();
  const dependencyPairs = new Set<string>();
  for (const d of dependencies) {
    if (
      !d ||
      !sameScope(d.scope, scope) ||
      d.approved !== true ||
      !nonempty(d.id) ||
      dependencyIds.has(d.id)
    )
      throw new Error("Invalid, cross-scope, or unapproved dependency");
    dependencyIds.add(d.id);
    const task = nodeMap.get(d.taskId),
      decision = nodeMap.get(d.decisionId);
    if (
      !task ||
      task.kind !== "todo" ||
      !decision ||
      decision.kind !== "decision"
    )
      throw new Error("Dangling dependency");
    const pair = JSON.stringify([d.taskId, d.decisionId]);
    if (dependencyPairs.has(pair))
      throw new Error("Duplicate dependency relationship");
    dependencyPairs.add(pair);
    const relation = await resolve(d.evidence);
    if (d.quote !== undefined) {
      if (
        !nonempty(d.quote) ||
        typeof relation.version.item.text !== "string" ||
        !relation.version.item.text.includes(d.quote)
      )
        throw new Error("Dependency quote not found in evidence");
    }
    const evidenceAt =
      relation.version.item.time || relation.version.item.timestamp || null;
    if (evidenceAt !== null) timestamp(evidenceAt);
    if (d.effectiveAt !== undefined) timestamp(d.effectiveAt);
    if (d.knownAt !== undefined) timestamp(d.knownAt);
    if (evidenceAt && d.knownAt && timestamp(d.knownAt) < timestamp(evidenceAt))
      throw new Error("Dependency known time precedes evidence");
    const effectiveAt = d.effectiveAt || evidenceAt;
    edges.push({
      kind: "DEPENDS_ON",
      id: d.id,
      from: task.id,
      to: decision.id,
      evidence: relation.ref,
      evidenceAt,
      effectiveAt,
      effectiveAtBasis:
        d.effectiveAt !== undefined
          ? "explicit"
          : evidenceAt
            ? "evidence-time"
            : "unknown",
      knownAt: d.knownAt || null,
    });
  }
  // Filter by time at query time: retaining future nodes preserves provenance.
  void at;
  return {
    scope: { ...scope },
    asOf,
    nodes: nodes.sort(byId),
    edges: edges.sort(
      (a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || byId(a, b),
    ),
    revisions: revisions.sort((a, b) =>
      a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
    ),
    corrections: corrections.sort(byId),
  };
}
function answerDependency({
  projection,
  decisionRootId,
  mode = "as-of",
  knowledgeCutoff,
}: {
  projection: Projection;
  decisionRootId: string;
  mode?: "as-of" | "current-known";
  knowledgeCutoff?: string;
}) {
  if (mode !== "as-of" && mode !== "current-known")
    throw new Error("Invalid correction mode");
  const root = projection.nodes.find(
    (n) => n.id === decisionRootId && n.kind === "decision",
  );
  if (!root) throw new Error("Decision root not found");
  const at = timestamp(projection.asOf),
    cutoff =
      knowledgeCutoff !== undefined
        ? timestamp(knowledgeCutoff)
        : mode === "as-of"
          ? at
          : null,
    edges = projection.edges.filter((e) => e.kind === "SUPERSEDES");
  const descendant = (n: Node) => {
    let id = n.id;
    const seen = new Set<string>();
    while (id !== root.id) {
      if (seen.has(id)) throw new Error("Revision cycle");
      seen.add(id);
      const e = projection.revisions.find((x) => x.from === id);
      if (!e) return false;
      id = e.to;
    }
    return true;
  };
  const related = projection.nodes.filter(
    (n) => ["decision", "change"].includes(n.kind) && descendant(n),
  );
  if (
    related.some(
      (n) =>
        n.basis === "confirmed" &&
        n.lifecycle === "active" &&
        n.effectiveAt === null,
    )
  )
    return { status: "ambiguous", reason: "effective time unavailable" };
  const eligible = related.filter(
    (n) =>
      n.basis === "confirmed" &&
      n.lifecycle === "active" &&
      n.effectiveAt !== null &&
      timestamp(n.effectiveAt) <= at,
  );
  const superseded = new Set(
    edges.filter((e) => eligible.some((n) => n.id === e.from)).map((e) => e.to),
  );
  const heads = eligible.filter((n) => !superseded.has(n.id));
  if (heads.length !== 1)
    return { status: "ambiguous", reason: "no unique confirmed decision" };
  const selected = heads[0];
  if (!selected) throw new Error("Missing decision");
  const corrections = projection.corrections.filter(
    (c) => c.target === selected.id,
  );
  if (corrections.length && (mode === "as-of" || knowledgeCutoff !== undefined))
    return {
      status: "ambiguous",
      reason: "correction effective time unavailable",
    };
  if (corrections.length > 1)
    return { status: "ambiguous", reason: "multiple corrections" };
  const correction = corrections[0];
  const relevantDependencies = projection.edges
    .filter((e) => e.kind === "DEPENDS_ON" && e.to === root.id)
    .filter((e) => {
      const task = projection.nodes.find((n) => n.id === e.from);
      return task && task.lifecycle === "active" && task.basis === "confirmed";
    });
  for (const e of relevantDependencies) {
    const task = projection.nodes.find((n) => n.id === e.from);
    if (!task || !task.effectiveAt)
      return { status: "ambiguous", reason: "task effective time unavailable" };
    if (timestamp(task.effectiveAt) > at) continue;
    if (!e.effectiveAt)
      return {
        status: "ambiguous",
        reason: "dependency effective time unavailable",
      };
    if (timestamp(e.effectiveAt) > at) continue;
    if (cutoff !== null && !e.knownAt)
      return {
        status: "ambiguous",
        reason: "dependency observation time unavailable",
      };
  }
  const tasks = relevantDependencies
    .flatMap((e) => {
      const task = projection.nodes.find((n) => n.id === e.from);
      if (
        !task ||
        !task.effectiveAt ||
        !e.effectiveAt ||
        timestamp(task.effectiveAt) > at ||
        timestamp(e.effectiveAt) > at ||
        (cutoff !== null && (!e.knownAt || timestamp(e.knownAt) > cutoff))
      )
        return [];
      return [
        {
          id: task.id,
          text: task.text,
          evidence: task.evidence,
          relationEvidence: e.evidence,
        },
      ];
    })
    .sort(byId);
  return {
    status: "resolved",
    decision: {
      id: selected.id,
      text: correction?.text || selected.text,
      evidence: selected.evidence,
      originalEvidence: selected.evidence,
      effectiveEvidence: correction ? correction.evidence : selected.evidence,
    },
    tasks,
  };
}
module.exports = { rebuildProjection, answerDependency };
