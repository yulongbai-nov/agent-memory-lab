"use strict";

// A standalone candidate protocol. This is not wired into any writer or cache.
import type {
  Basis,
  Kind,
  Evidence,
  Validated,
} from "../lib/candidate-contract-v2.cjs";
export type {
  Basis,
  Kind,
  Evidence,
  Candidate,
  CandidateEnvelope,
  Validated,
} from "../lib/candidate-contract-v2.cjs";
type OldValidated = {
  kind: Kind;
  claim: string;
  evidence: Evidence[];
  status: "待核实";
};

import * as v1 from "./semantic-validation.cjs";
const { validateCandidates: validateV1 } = v1 as {
  validateCandidates: (output: unknown, records: unknown) => OldValidated[];
};
const PROTOCOL = "candidate-v2" as const;
const BASES: readonly Basis[] = ["confirmed", "proposed", "uncertain"];
const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source", "item", "version", "quote"],
  properties: {
    source: { type: "string", minLength: 1, maxLength: 512 },
    item: { type: "string", minLength: 1, maxLength: 512 },
    version: { type: "string", minLength: 1, maxLength: 512 },
    quote: { type: "string", minLength: 1, maxLength: 4096 },
  },
};
const common = {
  claim: { type: "string", minLength: 1, maxLength: 4096 },
  evidence: { type: "array", minItems: 1, maxItems: 3, items: evidenceSchema },
};
const OUTPUT_SCHEMA_V2 = {
  type: "object",
  additionalProperties: false,
  required: ["protocol", "candidates"],
  properties: {
    protocol: { type: "string", const: PROTOCOL },
    candidates: {
      type: "array",
      maxItems: 4,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "basis", "claim", "evidence"],
            properties: {
              kind: { type: "string", const: "decision" },
              basis: { type: "string", enum: BASES },
              ...common,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "claim", "evidence"],
            properties: {
              kind: { type: "string", enum: ["change", "correction", "todo"] },
              ...common,
            },
          },
        ],
      },
    },
  },
};
function shape(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validateVersionedCandidates(
  output: unknown,
  records: unknown,
): Validated[] {
  if (
    !shape(output, ["protocol", "candidates"]) ||
    output.protocol !== PROTOCOL ||
    !Array.isArray(output.candidates) ||
    output.candidates.length > 4
  )
    throw new Error("unsupported or invalid candidate protocol");
  const bases: (Basis | null)[] = [];
  const stripped = output.candidates.map((candidate: unknown) => {
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      "kind" in candidate &&
      candidate.kind === "decision"
    ) {
      if (!shape(candidate, ["kind", "basis", "claim", "evidence"]))
        throw new Error("invalid decision basis");
      const record = candidate as Record<string, unknown>;
      if (
        typeof record.basis !== "string" ||
        !BASES.includes(record.basis as Basis)
      )
        throw new Error("invalid decision basis");
      bases.push(record.basis as Basis);
      return {
        kind: record.kind,
        claim: record.claim,
        evidence: record.evidence,
      };
    }
    if (!shape(candidate, ["kind", "claim", "evidence"]))
      throw new Error("invalid non-decision candidate");
    bases.push(null);
    return {
      kind: candidate.kind,
      claim: candidate.claim,
      evidence: candidate.evidence,
    };
  });
  const validated = validateV1({ candidates: stripped }, records);
  if (
    validated.some((candidate) =>
      candidate.evidence.some((evidence) => !wellFormed(evidence.quote)),
    )
  )
    throw new Error("invalid Unicode evidence quote");
  return validated.map((candidate, index) => {
    if (candidate.kind === "decision") {
      const basis = bases[index];
      if (basis == null) throw new Error("missing decision basis");
      return { ...candidate, kind: "decision", basis };
    }
    return { ...candidate, kind: candidate.kind };
  });
}
module.exports = { PROTOCOL, OUTPUT_SCHEMA_V2, validateVersionedCandidates };
