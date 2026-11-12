import type {
  Candidate,
  Receipt,
  Snapshot,
  Capsule,
} from "../src/candidate-review-contract.cjs";
const valid: Candidate = {
  kind: "decision",
  basis: "confirmed",
  status: "待核实",
  claim: "x",
  evidence: [],
};
// @ts-expect-error decision requires basis
const missing: Candidate = {
  kind: "decision",
  status: "待核实",
  claim: "x",
  evidence: [],
};
const invalid: Candidate = {
  kind: "todo",
  // @ts-expect-error todo cannot carry basis
  basis: "confirmed",
  status: "待核实",
  claim: "x",
  evidence: [],
};
const candidates = (r: Receipt, s: Snapshot, c: Capsule) => [
  r.candidates,
  s.candidates,
  c.candidate,
];
void [valid, missing, invalid, candidates];
