"use strict";
// A fresh process substitutes the actual oracle module before the reader loads.
// This process receives only synthetic switch values, never credentials.
const oraclePath = require.resolve("./paired-oracle.cjs");
const original = require(oraclePath);
let changedRules = 0;
const variant = process.argv[2];
const leak = process.argv[3] === "leak";
if (!["original", "modified"].includes(variant) || !process.send)
  throw Error("invalid synthetic worker");
if (variant === "modified") {
  const modified = structuredClone(original);
  for (const rules of Object.values(modified))
    for (const rule of rules) {
      rule.values = rule.values.map((value) => `counterfactual-${value}`);
      rule.required = [["counterfactual-missing-reference"]];
      rule.relevant = ["counterfactual-missing-reference"];
    }
  for (const [id, rules] of Object.entries(modified))
    for (const [i, rule] of rules.entries()) {
      if (
        ["values", "required", "relevant"].every(
          (key) =>
            JSON.stringify(rule[key]) !== JSON.stringify(original[id][i][key]),
        )
      )
        changedRules++;
    }
  if (changedRules !== 8)
    throw Error("counterfactual did not change every oracle item");
  require.cache[oraclePath].exports = modified;
}
const { construct, preflight, score } = require("./paired-reader.cjs");
(async () => {
  const samples = await construct();
  if (leak) {
    // Deliberate negative control: leak the actual substituted oracle into all prompts.
    for (const sample of samples) {
      const body = JSON.parse(sample.body);
      body.instructions += `\nORACLE_LEAK_NEGATIVE_CONTROL ${JSON.stringify(require(oraclePath)[sample.id])}`;
      sample.body = JSON.stringify(body);
    }
  }
  const wire = await preflight(samples);
  const probe = samples.find(
    (s) => s.id === "temporal-slot" && s.arm === "structured-bundle",
  );
  const answer = {
    status: "partial",
    facts: [
      { value: "Tuesday", citations: [probe.refById.clarify] },
      { value: null, citations: [] },
    ],
  };
  process.send(
    {
      ok: true,
      wire,
      changedRules,
      assessment: score(probe, answer, require(oraclePath)),
    },
    () => process.disconnect(),
  );
})().catch(() => {
  process.send({ ok: false }, () => process.disconnect());
});
