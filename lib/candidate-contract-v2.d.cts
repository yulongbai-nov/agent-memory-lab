export type Basis = "confirmed" | "proposed" | "uncertain";
export type Kind = "decision" | "change" | "correction" | "todo";
export type Evidence = {
  source: string;
  item: string;
  version: string;
  quote: string;
};
export type Candidate =
  | { kind: "decision"; basis: Basis; claim: string; evidence: Evidence[] }
  | {
      kind: "change" | "correction" | "todo";
      claim: string;
      evidence: Evidence[];
    };
export type CandidateEnvelope = {
  protocol: "candidate-v2";
  candidates: Candidate[];
};
export type Validated = Candidate & { status: "待核实" };
export const PROTOCOL: "candidate-v2";
export const OUTPUT_SCHEMA_V2: Readonly<Record<string, unknown>>;
export function validateVersionedCandidates(
  output: unknown,
  records: unknown,
): Validated[];
