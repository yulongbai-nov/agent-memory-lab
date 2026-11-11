"use strict";
const norm = (x) =>
  x
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "");
function score(sample, answer, oracle) {
  const rules = oracle[sample.id],
    sources = sample.context.sources,
    reviews = sample.context.reviews;
  const refs = new Set(sources.map((s) => s.ref));
  const keys = (x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.keys(x).sort().join(",")
      : "";
  const valid =
    keys(answer) === "facts,status" &&
    ["resolved", "partial", "unknown"].includes(answer.status) &&
    Array.isArray(answer.facts) &&
    answer.facts.length === 2 &&
    answer.facts.every(
      (f) =>
        keys(f) === "citations,value" &&
        (f.value === null || typeof f.value === "string") &&
        Array.isArray(f.citations) &&
        f.citations.every((c) => typeof c === "string") &&
        (f.value !== null || f.citations.length === 0),
    );
  if (!valid) return { protocolError: true, items: [] };
  const n = answer.facts.filter((f) => f.value !== null).length;
  if (answer.status !== ["unknown", "partial", "resolved"][n])
    return { protocolError: true, items: [] };
  const relationValid = (rule) =>
    !rule.relation ||
    reviews.some(
      (r) =>
        r.type === "dependency" &&
        r.approved === true &&
        Number.isInteger(r.evidence) &&
        sample.refById.relation === sources[r.evidence]?.ref &&
        typeof sample.decisionRootId === "string" &&
        r.decision === sample.decisionRootId &&
        reviews.some(
          (t) =>
            t.id === r.task &&
            t.type === "todo" &&
            t.basis === "confirmed" &&
            t.lifecycle === "active" &&
            sources[t.target]?.ref === sample.refById.task,
        ) &&
        Number.isFinite(Date.parse(r.effectiveAt)) &&
        Date.parse(r.effectiveAt) <= Date.parse(sample.asOf) &&
        Number.isFinite(Date.parse(r.knownAt)) &&
        Number.isFinite(Date.parse(sources[r.evidence]?.time)) &&
        Date.parse(r.knownAt) >= Date.parse(sources[r.evidence].time) &&
        Date.parse(r.knownAt) <= Date.parse(sample.knowledgeCutoff),
    );
  const items = rules.map((rule, i) => {
    const alternatives = rule.required.map((set) =>
      set.map((id) => sample.refById[id]),
    );
    const correctionValid =
      !rule.correction ||
      reviews.some(
        (r) =>
          r.type === "correction" &&
          r.basis === "confirmed" &&
          r.lifecycle === "active" &&
          reviews.some(
            (d) =>
              d.type === "decision" &&
              d.id === r.revises &&
              d.basis === "confirmed" &&
              d.lifecycle === "active" &&
              sources[d.target]?.ref ===
                (sample.refById.original ?? sample.refById.old),
          ) &&
          sources[r.evidence]?.ref === sample.refById.clarify &&
          sources[r.target]?.ref ===
            (sample.refById.original ?? sample.refById.old),
      );
    const supported =
      correctionValid &&
      relationValid(rule) &&
      alternatives.some((set) => set.every((ref) => ref && refs.has(ref)));
    const fact = answer.facts[i];
    if (fact.value === null)
      return {
        supported,
        outcome: supported ? "omission" : "justified-refusal",
      };
    if (!supported) return { supported, outcome: "unsupported-assertion" };
    const correct = rule.values.includes(norm(fact.value));
    const relevant = new Set(rule.relevant.map((id) => sample.refById[id]));
    const citationCorrect =
      fact.citations.length > 0 &&
      fact.citations.every((ref) => refs.has(ref) && relevant.has(ref)) &&
      alternatives.some((set) =>
        set.every((ref) => fact.citations.includes(ref)),
      );
    return {
      supported,
      outcome: !correct
        ? "semantic-error"
        : !citationCorrect
          ? "citation-error"
          : "correct",
      semanticCorrect: correct,
      citationCorrect,
    };
  });
  return { protocolError: false, items };
}
module.exports = { score };
