import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { compareBound } from "./query-time.cjs";

const { canonical } = createRequire(__filename)("../storage.cjs") as {
  canonical: (value: unknown) => string;
};
const hash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const hex = { type: "string", pattern: "^[a-f0-9]{64}$" };
const label = { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const ref = {
  source: { ...label, pattern: "^(?:codex|dsh)/[^/]+/[^/]+$" },
  item: label,
  version: hex,
};
const span = {
  kind: { enum: ["full", "fragment", "relay-input"] },
  fieldPath: label,
  originalSha256: hex,
  startUtf16: { type: "integer", minimum: 0, maximum: 1048576 },
  endUtf16: { type: "integer", minimum: 0, maximum: 1048576 },
  startUtf8: { type: "integer", minimum: 0, maximum: 1048576 },
  endUtf8: { type: "integer", minimum: 0, maximum: 1048576 },
  previewStartUtf16: { type: "integer", minimum: 0, maximum: 1048576 },
  previewEndUtf16: { type: "integer", minimum: 0, maximum: 1048576 },
};
const evidence = object({
  ...ref,
  quote: { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" },
  originalSpan: object(span),
});
const candidate = {
  oneOf: [
    object({
      kind: { const: "decision" },
      basis: { enum: ["confirmed", "proposed", "uncertain"] },
      status: { const: "待核实" },
      claim: { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" },
      evidence: { type: "array", minItems: 1, maxItems: 3, items: evidence },
    }),
    object({
      kind: { enum: ["change", "correction", "todo"] },
      status: { const: "待核实" },
      claim: { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" },
      evidence: { type: "array", minItems: 1, maxItems: 3, items: evidence },
    }),
  ],
};
const producer = object({
  writerProtocol: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "\\S",
  },
  recipeIdentity: hex,
  outputProtocol: { const: "candidate-v2" },
});
const admission = object({
  kind: { const: "operator-import" },
  receiptSha256: hex,
});
const generatedAt = {
  anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 40 }],
};
const projections = {
  type: "array",
  maxItems: 12,
  items: object({ ...ref, ...span }),
};
const ajv = new Ajv({ ownProperties: true });
const checkReceipt = ajv.compile(
  object(
    {
      formatVersion: { const: 2 },
      scope: object({ owner: label, project: label }),
      producer,
      generatedAt,
      originReceiptSha256: hex,
      inputProjections: projections,
      candidates: { type: "array", maxItems: 4, items: candidate },
    },
    [
      "formatVersion",
      "scope",
      "producer",
      "generatedAt",
      "inputProjections",
      "candidates",
    ],
  ),
);
const checkSnapshot = ajv.compile(
  object(
    {
      formatVersion: { const: 2 },
      scopeKey: hex,
      producer,
      generatedAt,
      originReceiptSha256: hex,
      admission,
      inputProjections: projections,
      candidates: { type: "array", maxItems: 4, items: candidate },
    },
    [
      "formatVersion",
      "scopeKey",
      "producer",
      "generatedAt",
      "admission",
      "inputProjections",
      "candidates",
    ],
  ),
);
const checkCapsule = ajv.compile(
  object(
    {
      formatVersion: { const: 2 },
      snapshotSha256: hex,
      ordinal: { type: "integer", minimum: 1, maximum: 4 },
      candidateSha256: hex,
      reviewedAt: { type: "string", minLength: 1, maxLength: 40 },
      producer,
      generatedAt,
      originReceiptSha256: hex,
      admission,
      candidate,
      inputProjections: projections,
      primary: { type: "integer", minimum: 1, maximum: 3 },
    },
    [
      "formatVersion",
      "snapshotSha256",
      "ordinal",
      "candidateSha256",
      "reviewedAt",
      "producer",
      "generatedAt",
      "admission",
      "candidate",
      "inputProjections",
      "primary",
    ],
  ),
);
type Source = { source: string; item: string; version: string };
type Span = {
  kind: "full" | "fragment" | "relay-input";
  fieldPath: string;
  originalSha256: string;
  startUtf16: number;
  endUtf16: number;
  startUtf8: number;
  endUtf8: number;
  previewStartUtf16: number;
  previewEndUtf16: number;
};
type Projection = Source & Span;
type Candidate = {
  status: "待核实";
  claim: string;
  evidence: (Source & { quote: string; originalSpan: Span })[];
} & (
  | { kind: "decision"; basis: "confirmed" | "proposed" | "uncertain" }
  | { kind: "change" | "correction" | "todo"; basis?: never }
);
type Producer = {
  writerProtocol: string;
  recipeIdentity: string;
  outputProtocol: "candidate-v2";
};
type Receipt = {
  formatVersion: 2;
  scope: { owner: string; project: string };
  producer: Producer;
  generatedAt: string | null;
  originReceiptSha256?: string;
  inputProjections: Projection[];
  candidates: Candidate[];
};
type Snapshot = Omit<Receipt, "scope"> & {
  scopeKey: string;
  admission: { kind: "operator-import"; receiptSha256: string };
};
type Capsule = Omit<Snapshot, "scopeKey" | "candidates"> & {
  snapshotSha256: string;
  ordinal: number;
  candidateSha256: string;
  reviewedAt: string;
  candidate: Candidate;
  primary: number;
};
function saneMetadata(producerValue: Producer, at: string | null) {
  return (
    Buffer.byteLength(producerValue.writerProtocol) <= 128 &&
    (at === null || compareBound(at, at) !== null)
  );
}
function checkReferences(candidates: Candidate[], inputs: Projection[]) {
  const candidatesSeen = new Set<string>();
  for (const c of candidates) {
    const key = JSON.stringify([c.kind, c.claim]);
    if (candidatesSeen.has(key)) throw Error("Duplicate candidate");
    candidatesSeen.add(key);
    const seen = new Set<string>();
    for (const e of c.evidence) {
      const ref = JSON.stringify([e.source, e.item, e.version, e.quote]);
      if (seen.has(ref)) throw Error("Duplicate evidence");
      seen.add(ref);
    }
  }
  if (
    inputs.some(
      (p) =>
        !candidates.some((c) =>
          c.evidence.some(
            (e) =>
              e.source === p.source &&
              e.item === p.item &&
              e.version === p.version &&
              e.originalSpan.fieldPath === p.fieldPath &&
              e.originalSpan.originalSha256 === p.originalSha256 &&
              e.originalSpan.previewStartUtf16 >= p.previewStartUtf16 &&
              e.originalSpan.previewEndUtf16 <= p.previewEndUtf16,
          ),
        ),
    )
  )
    throw Error("Unrelated candidate projection");
  for (const c of candidates)
    for (const e of c.evidence) {
      if (
        !inputs.some(
          (p) =>
            p.source === e.source &&
            p.item === e.item &&
            p.version === e.version,
        )
      )
        throw Error("Missing evidence projection");
    }
}
function validateReceipt(value: unknown): Receipt {
  if (!checkReceipt(value)) throw Error("Invalid candidate receipt");
  const r = value as Receipt;
  if (!saneMetadata(r.producer, r.generatedAt)) throw Error("Invalid producer");
  checkReferences(r.candidates, r.inputProjections);
  return r;
}
function validateSnapshot(value: unknown): Snapshot {
  if (!checkSnapshot(value)) throw Error("Invalid candidate snapshot");
  const s = value as Snapshot;
  if (!saneMetadata(s.producer, s.generatedAt)) throw Error("Invalid producer");
  checkReferences(s.candidates, s.inputProjections);
  return s;
}
function validateCapsule(value: unknown): Capsule {
  if (!checkCapsule(value) || Buffer.byteLength(JSON.stringify(value)) > 65536)
    throw Error("Invalid candidate review");
  const c = value as Capsule;
  if (
    !saneMetadata(c.producer, c.generatedAt) ||
    compareBound(c.reviewedAt, c.reviewedAt) === null ||
    c.primary > c.candidate.evidence.length ||
    c.candidateSha256 !== hash(canonical(c.candidate))
  )
    throw Error("Invalid candidate review");
  checkReferences([c.candidate], c.inputProjections);
  if (
    c.inputProjections.some(
      (p) =>
        !c.candidate.evidence.some(
          (e) =>
            e.source === p.source &&
            e.item === p.item &&
            e.version === p.version,
        ),
    )
  )
    throw Error("Unrelated review projection");
  return c;
}
export { validateReceipt, validateSnapshot, validateCapsule, hash, canonical };
export type { Receipt, Snapshot, Capsule, Candidate, Projection, Span, Source };
