"use strict";
// Isolated process swaps the real scoring oracle before constructing alias requests.
const oraclePath = require.resolve("./paired-oracle.cjs");
const original = require(oraclePath),
  variant = process.argv[2],
  leak = process.argv[3] === "leak";
if (!["original", "modified"].includes(variant) || !process.send)
  throw Error("Invalid synthetic worker");
let changedRules = 0;
if (variant === "modified") {
  const modified = structuredClone(original);
  for (const rules of Object.values(modified))
    for (const rule of rules) {
      rule.values = rule.values.map((value) => `counterfactual-${value}`);
      rule.required = [["counterfactual-missing-reference"]];
      rule.relevant = ["counterfactual-missing-reference"];
    }
  for (const [id, rules] of Object.entries(modified))
    for (const [i, rule] of rules.entries())
      if (
        ["values", "required", "relevant"].every(
          (key) =>
            JSON.stringify(rule[key]) !== JSON.stringify(original[id][i][key]),
        )
      )
        changedRules++;
  if (changedRules !== 8) throw Error("Oracle substitution incomplete");
  require.cache[oraclePath].exports = modified;
}
const {
  constructAliases,
  decodeSampleAnswer,
} = require("./paired-alias-preflight.cjs");
const { preflight, score } = require("./paired-reader.cjs");
(async () => {
  const samples = await constructAliases();
  if (leak)
    for (const sample of samples) {
      const body = JSON.parse(sample.body);
      body.instructions += `\nORACLE_LEAK_NEGATIVE_CONTROL ${JSON.stringify(require(oraclePath)[sample.id])}`;
      sample.body = JSON.stringify(body);
    }
  const wire = await preflight(samples),
    probe = samples.find(
      (x) => x.id === "temporal-slot" && x.arm === "structured-bundle",
    );
  const alias = probe.mapping.entries.find(
    (x) => x.ref === probe.refById.clarify,
  ).alias;
  const answer = decodeSampleAnswer(probe, {
    status: "partial",
    facts: [
      { value: "Tuesday", citations: [alias] },
      { value: null, citations: [] },
    ],
  });
  process.send(
    {
      ok: true,
      wire,
      changedRules,
      assessment: score(probe, answer, require(oraclePath)),
    },
    () => process.disconnect(),
  );
})().catch(() => process.send({ ok: false }, () => process.disconnect()));
