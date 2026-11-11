"use strict";
// Synthetic, package-local display codec. Full references remain authoritative.
const { createHash } = require("node:crypto");
function identity(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.arm !== "string" ||
    !value.arm ||
    !value.scope ||
    typeof value.scope.owner !== "string" ||
    !value.scope.owner ||
    typeof value.scope.project !== "string" ||
    !value.scope.project
  )
    throw Error("Invalid package identity");
  return {
    id: value.id,
    arm: value.arm,
    scope: { owner: value.scope.owner, project: value.scope.project },
  };
}
function encodeContext(context, selected) {
  const binding = identity(selected);
  if (
    !context ||
    !Array.isArray(context.sources) ||
    !Array.isArray(context.reviews)
  )
    throw Error("Invalid context");
  const entries = [],
    aliases = new Set(),
    refs = new Set();
  const result = structuredClone(context);
  const scope = binding.scope;
  if (
    (!scope && result.reviews.length) ||
    result.reviews.some(
      (row) =>
        row.scope?.owner !== scope?.owner ||
        row.scope?.project !== scope?.project,
    )
  )
    throw Error("Invalid package scope");
  const packageDigest = createHash("sha256")
    .update(JSON.stringify(context))
    .digest("hex");
  for (const source of result.sources) {
    let ref;
    try {
      ref = JSON.parse(source.ref);
    } catch {
      throw Error("Invalid exact reference");
    }
    if (
      !Array.isArray(ref) ||
      ref.length !== 7 ||
      JSON.stringify(ref) !== source.ref ||
      !ref.every((x) => typeof x === "string" && x) ||
      source.scope?.owner !== ref[0] ||
      source.scope?.project !== ref[1] ||
      source.scope?.owner !== scope.owner ||
      source.scope?.project !== scope.project ||
      refs.has(source.ref)
    )
      throw Error("Invalid scoped reference");
    const alias =
      "e" +
      createHash("sha256")
        .update(
          JSON.stringify([binding.id, binding.arm, packageDigest, source.ref]),
        )
        .digest("hex")
        .slice(0, 12);
    if (aliases.has(alias)) throw Error("Alias collision");
    aliases.add(alias);
    refs.add(source.ref);
    entries.push({ alias, ref: source.ref });
    source.ref = alias;
  }
  return { context: result, mapping: { ...binding, entries } };
}
function verified(original, selected, mapping) {
  const expected = encodeContext(original, selected);
  if (JSON.stringify(expected.mapping) !== JSON.stringify(mapping))
    throw Error("Alias mapping mismatch");
  return expected;
}
function decodeContext(encoded, original, selected, mapping) {
  const expected = verified(original, selected, mapping);
  if (JSON.stringify(encoded) !== JSON.stringify(expected.context))
    throw Error("Encoded context mismatch");
  return structuredClone(original);
}
function decodeAnswer(answer, original, selected, mapping) {
  verified(original, selected, mapping);
  if (!answer || !Array.isArray(answer.facts)) throw Error("Invalid answer");
  const refs = new Map(mapping.entries.map(({ alias, ref }) => [alias, ref]));
  const result = structuredClone(answer);
  for (const fact of result.facts) {
    if (!fact || !Array.isArray(fact.citations))
      throw Error("Invalid citations");
    fact.citations = fact.citations.map((alias) => {
      if (typeof alias !== "string" || !refs.has(alias))
        throw Error("Unknown alias");
      return refs.get(alias);
    });
  }
  return result;
}
module.exports = { encodeContext, decodeContext, decodeAnswer };
