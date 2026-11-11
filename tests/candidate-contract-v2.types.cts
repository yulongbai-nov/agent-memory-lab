import type {
  Candidate,
  CandidateEnvelope,
} from "../lib/candidate-contract-v2.cjs";
const evidence = [{ source: "s", item: "i", version: "v", quote: "q" }];
const good: CandidateEnvelope = {
  protocol: "candidate-v2",
  candidates: [{ kind: "decision", basis: "proposed", claim: "x", evidence }],
};
// @ts-expect-error decision requires a basis
const missing: Candidate = { kind: "decision", claim: "x", evidence };
const extra: Candidate = {
  kind: "todo",
  // @ts-expect-error only decisions carry a basis
  basis: "confirmed",
  claim: "x",
  evidence,
};
const bad: Candidate = {
  kind: "decision",
  // @ts-expect-error unsupported basis
  basis: "settled",
  claim: "x",
  evidence,
};
void [good, missing, extra, bad];
