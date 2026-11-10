"use strict";

const { readFile, lstat } =
  require("node:fs/promises") as typeof import("node:fs/promises");
const { join } = require("node:path") as typeof import("node:path");
const { createHash } = require("node:crypto") as typeof import("node:crypto");

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
    metadata?: {
      original?: { availability?: string; sha256?: string; bytes?: number };
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
  quote?: string;
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
  dir?: string;
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
      const original = relation.version.item.metadata?.original;
      if (
        !archive.dir ||
        original?.availability !== "archived" ||
        typeof original.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(original.sha256) ||
        !Number.isSafeInteger(original.bytes) ||
        (original.bytes || 0) < 1 ||
        (original.bytes || 0) > 1048576
      )
        throw new Error("Dependency quote original unavailable");
      const filename = join(
        archive.dir,
        "originals",
        original.sha256 + ".jsonl",
      );
      let bytes: Buffer;
      try {
        const info = await lstat(filename);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== original.bytes ||
          info.mode & 0o077
        )
          throw new Error("invalid");
        bytes = await readFile(filename);
      } catch {
        throw new Error("Dependency quote original unavailable");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== original.sha256)
        throw new Error("Dependency quote original invalid");
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("Dependency quote original invalid");
      }
      const contains = (value: unknown): boolean =>
        typeof value === "string"
          ? value.includes(d.quote as string)
          : Array.isArray(value)
            ? value.some(contains)
            : !!value &&
              typeof value === "object" &&
              Object.values(value).some(contains);
      if (!contains(raw))
        throw new Error("Dependency quote not found in original");
    }
    edges.push({
      kind: "DEPENDS_ON",
      id: d.id,
      from: task.id,
      to: decision.id,
      evidence: relation.ref,
      ...(d.quote !== undefined ? { quote: d.quote } : {}),
      effectiveAt: task.effectiveAt,
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
}: {
  projection: Projection;
  decisionRootId: string;
  mode?: "as-of" | "current-known";
}) {
  if (mode !== "as-of" && mode !== "current-known")
    throw new Error("Invalid correction mode");
  const root = projection.nodes.find(
    (n) => n.id === decisionRootId && n.kind === "decision",
  );
  if (!root) throw new Error("Decision root not found");
  const at = timestamp(projection.asOf),
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
  if (corrections.length && mode === "as-of")
    return {
      status: "ambiguous",
      reason: "correction effective time unavailable",
    };
  if (corrections.length > 1)
    return { status: "ambiguous", reason: "multiple corrections" };
  const correction = corrections[0];
  const tasks = projection.edges
    .filter((e) => e.kind === "DEPENDS_ON" && e.to === root.id)
    .flatMap((e) => {
      const task = projection.nodes.find((n) => n.id === e.from);
      if (!task || task.lifecycle !== "active" || task.basis !== "confirmed")
        return [];
      if (!task.effectiveAt) return [];
      return timestamp(task.effectiveAt) <= at
        ? [
            {
              id: task.id,
              text: task.text,
              evidence: task.evidence,
              relationEvidence: e.evidence,
              ...(e.quote !== undefined ? { relationQuote: e.quote } : {}),
            },
          ]
        : [];
    })
    .sort(byId);
  if (
    projection.edges.some(
      (e) =>
        e.kind === "DEPENDS_ON" &&
        e.to === root.id &&
        projection.nodes.some(
          (n) =>
            n.id === e.from &&
            n.lifecycle === "active" &&
            n.basis === "confirmed" &&
            n.effectiveAt === null,
        ),
    )
  )
    return { status: "ambiguous", reason: "task effective time unavailable" };
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
