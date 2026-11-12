import { createHash } from "node:crypto";
import { compareBound } from "./query-time.cjs";

export type Purpose = "training" | "evaluation";
export type Split = "train" | "validation" | "test";
export type Label =
  "decision" | "correction" | "change" | "task" | "conflict" | "negative";
export interface EvidenceRef {
  owner: string;
  project: string;
  harness: string;
  instance: string;
  session: string;
  entry: string;
  revision: string;
}
export interface RegistryEntry extends EvidenceRef {
  contentHash: string;
  excerpt?: string;
  sourceSessionId?: string;
}
export interface Grant extends EvidenceRef {
  purpose: Purpose;
  authorizationId?: string;
}
export interface Sample {
  id: string;
  query: string;
  expected: string;
  purpose: Purpose;
  split: Split;
  labels: Label[];
  evidence: EvidenceRef[];
  validTime?: string;
  observedTime?: string;
}
export interface ManifestInput {
  registry: RegistryEntry[];
  grants: Grant[];
  samples: Sample[];
}
export interface TrainingManifest extends ManifestInput {
  version: "training-manifest-v1";
  contentHash: string;
}

const refFields = [
  "owner",
  "project",
  "harness",
  "instance",
  "session",
  "entry",
  "revision",
] as const;
const labels = new Set([
  "decision",
  "correction",
  "change",
  "task",
  "conflict",
  "negative",
]);
const maxItems = 10000;

function object(
  value: unknown,
  fields: readonly string[],
  where: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key)))
    throw new Error(`${where} has an unknown field`);
  return result;
}
function text(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(`${where} must be a non-empty bounded string`);
  }
  return value;
}
function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems)
    throw new Error(`${where} must be a non-empty bounded array`);
  return value as unknown[];
}
function ref(value: Record<string, unknown>): EvidenceRef {
  return {
    owner: text(value.owner, "owner"),
    project: text(value.project, "project"),
    harness: text(value.harness, "harness"),
    instance: text(value.instance, "instance"),
    session: text(value.session, "session"),
    entry: text(value.entry, "entry"),
    revision: text(value.revision, "revision"),
  };
}
function purpose(value: unknown): Purpose {
  if (value !== "training" && value !== "evaluation")
    throw new Error("invalid purpose");
  return value;
}
function split(value: unknown): Split {
  if (value !== "train" && value !== "validation" && value !== "test")
    throw new Error("invalid split");
  return value;
}
function time(value: unknown, where: string): string {
  const result = text(value, where);
  if (compareBound(result, result) === null)
    throw new Error(`${where} must be an RFC3339 timestamp`);
  return result;
}
function key(value: EvidenceRef): string {
  return JSON.stringify(refFields.map((field) => value[field]));
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function unique<T>(
  items: T[],
  keyOf: (item: T) => string,
  where: string,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const k = keyOf(item);
    if (seen.has(k)) throw new Error(`duplicate ${where}`);
    seen.add(k);
  }
}

/** Grants are trusted caller-supplied authorizations, not claims made by samples. */
export function buildTrainingManifest(input: unknown): TrainingManifest {
  const root = object(input, ["registry", "grants", "samples"], "input");
  const registry = array(root.registry, "registry").map((item) => {
    const o = object(
      item,
      [...refFields, "contentHash", "excerpt", "sourceSessionId"],
      "registry entry",
    );
    const contentHash = text(o.contentHash, "contentHash");
    if (!/^sha256:[0-9a-f]{64}$/u.test(contentHash))
      throw new Error("invalid evidence contentHash");
    const entry: RegistryEntry = { ...ref(o), contentHash };
    if (Object.hasOwn(o, "excerpt"))
      entry.excerpt = text(o.excerpt, "evidence excerpt");
    if (Object.hasOwn(o, "sourceSessionId"))
      entry.sourceSessionId = text(o.sourceSessionId, "sourceSessionId");
    return entry;
  });
  const grants = array(root.grants, "grants").map((item) => {
    const o = object(
      item,
      [...refFields, "purpose", "authorizationId"],
      "grant",
    );
    const grant: Grant = { ...ref(o), purpose: purpose(o.purpose) };
    if (Object.hasOwn(o, "authorizationId"))
      grant.authorizationId = text(o.authorizationId, "authorizationId");
    return grant;
  });
  const samples: Sample[] = array(root.samples, "samples").map((item) => {
    const o = object(
      item,
      [
        "id",
        "query",
        "expected",
        "purpose",
        "split",
        "labels",
        "evidence",
        "validTime",
        "observedTime",
      ],
      "sample",
    );
    const p = purpose(o.purpose);
    const s = split(o.split);
    if ((s === "train") !== (p === "training"))
      throw new Error("purpose does not match split");
    const sampleLabels = array(o.labels, "labels").map((label) => {
      if (typeof label !== "string" || !labels.has(label))
        throw new Error("invalid label");
      return label as Label;
    });
    unique(sampleLabels, (label) => label, "label");
    sampleLabels.sort(compare);
    const evidence = array(o.evidence, "evidence").map((e) =>
      ref(object(e, refFields, "evidence reference")),
    );
    unique(evidence, key, "evidence reference");
    const result: Sample = {
      id: text(o.id, "sample id"),
      query: text(o.query, "query"),
      expected: text(o.expected, "expected"),
      purpose: p,
      split: s,
      labels: sampleLabels,
      evidence,
    };
    if (Object.hasOwn(o, "validTime"))
      result.validTime = time(o.validTime, "validTime");
    if (Object.hasOwn(o, "observedTime"))
      result.observedTime = time(o.observedTime, "observedTime");
    return result;
  });
  unique(registry, key, "registry revision");
  unique(
    grants,
    (grant) => JSON.stringify([key(grant), grant.purpose]),
    "grant",
  );
  unique(samples, (sample) => sample.id, "sample id");
  const registered = new Set(registry.map(key));
  const authorized = new Set(
    grants.map((grant) => JSON.stringify([key(grant), grant.purpose])),
  );
  for (const grant of grants)
    if (!registered.has(key(grant)))
      throw new Error("grant references missing registry revision");
  const registryByKey = new Map(registry.map((entry) => [key(entry), entry]));
  const usedRefs = new Set<string>();
  const usedGrants = new Set<string>();
  const sessions = new Map<string, Split>();
  for (const sample of samples)
    for (const evidence of sample.evidence) {
      const k = key(evidence);
      if (!registered.has(k)) throw new Error("missing registry revision");
      if (!authorized.has(JSON.stringify([k, sample.purpose])))
        throw new Error("missing trusted purpose grant");
      usedRefs.add(k);
      usedGrants.add(JSON.stringify([k, sample.purpose]));
      const lineage = registryByKey.get(k)?.sourceSessionId;
      if (lineage !== undefined) {
        const lineageKey = JSON.stringify(["lineage", lineage]);
        const priorLineage = sessions.get(lineageKey);
        if (priorLineage !== undefined && priorLineage !== sample.split)
          throw new Error("source session crosses splits");
        sessions.set(lineageKey, sample.split);
      }
      // Scope copies and later entry revisions are the same underlying source session.
      const sessionKey = JSON.stringify([
        evidence.harness,
        evidence.instance,
        evidence.session,
      ]);
      const prior = sessions.get(sessionKey);
      if (prior !== undefined && prior !== sample.split)
        throw new Error("source session crosses splits");
      sessions.set(sessionKey, sample.split);
    }
  registry.sort((a, b) => compare(key(a), key(b)));
  grants.sort((a, b) =>
    compare(
      JSON.stringify([key(a), a.purpose]),
      JSON.stringify([key(b), b.purpose]),
    ),
  );
  samples.sort((a, b) => compare(a.id, b.id));
  const body = {
    version: "training-manifest-v1" as const,
    registry: registry.filter((entry) => usedRefs.has(key(entry))),
    grants: grants.filter((grant) =>
      usedGrants.has(JSON.stringify([key(grant), grant.purpose])),
    ),
    samples,
  };
  const contentHash = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
  return { ...body, contentHash };
}
