"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { construct } = require("../benchmark/memory-views/paired-reader.cjs");
const {
  constructAliases,
  decodeSampleAnswer,
  run,
} = require("../benchmark/memory-views/paired-alias-preflight.cjs");
const {
  encodeContext,
  decodeContext,
  decodeAnswer,
} = require("../benchmark/memory-views/reference-alias.cjs");
test("all eight preserve selected evidence, question, schema and text with reversible references", async () => {
  const originals = await construct(),
    aliases = await constructAliases();
  assert.equal(aliases.length, 8);
  for (let i = 0; i < 8; i++) {
    const a = aliases[i],
      o = originals[i],
      id = { id: a.id, arm: a.arm, scope: a.scope };
    assert.equal(a.id, o.id);
    assert.equal(a.arm, o.arm);
    assert.deepEqual(a.context, o.context);
    const oldBody = JSON.parse(o.body),
      newBody = JSON.parse(a.body),
      oldInput = JSON.parse(oldBody.input),
      newInput = JSON.parse(newBody.input);
    assert.deepEqual(
      decodeContext(newInput.evidence, o.context, id, a.mapping),
      oldInput.evidence,
    );
    assert.equal(newInput.question, oldInput.question);
    delete oldBody.input;
    delete newBody.input;
    assert.deepEqual(newBody, oldBody);
    assert.ok(Buffer.byteLength(JSON.stringify(o.context)) <= 1900);
    assert.ok(o.context.sources.length <= 3);
    const first = a.mapping.entries[0],
      answer = {
        status: "partial",
        facts: [
          { value: "x", citations: [first.alias, first.alias] },
          { value: null, citations: [] },
        ],
      };
    assert.deepEqual(decodeSampleAnswer(a, answer).facts[0].citations, [
      first.ref,
      first.ref,
    ]);
    assert.throws(() =>
      decodeAnswer(
        answer,
        o.context,
        { ...id, arm: id.arm + "-wrong" },
        a.mapping,
      ),
    );
    assert.throws(() =>
      decodeSampleAnswer(a, {
        ...answer,
        facts: [
          { value: "x", citations: ["e000000000000"] },
          { value: null, citations: [] },
        ],
      }),
    );
    const tampered = structuredClone(a.mapping);
    tampered.entries[0].ref = "forged";
    assert.throws(() => decodeAnswer(answer, o.context, id, tampered));
  }
});
test("only source ref fields change, preserving source text and rejecting unsafe maps", () => {
  const ref = JSON.stringify(["o", "p", "codex", "i", "s", "x", "revision"]);
  const context = {
    sources: [
      {
        ref,
        scope: { owner: "o", project: "p" },
        time: "t",
        text: `A literal ${ref} stays unchanged`,
      },
    ],
    reviews: [{ scope: { owner: "o", project: "p" }, target: 0, text: ref }],
  };
  const id = { id: "case", arm: "arm", scope: { owner: "o", project: "p" } },
    encoded = encodeContext(context, id);
  assert.equal(encoded.context.sources[0].text, context.sources[0].text);
  assert.equal(encoded.context.reviews[0].text, ref);
  assert.deepEqual(
    decodeContext(encoded.context, context, id, encoded.mapping),
    context,
  );
  const bad = structuredClone(encoded.context);
  bad.sources[0].text = "changed";
  assert.throws(() => decodeContext(bad, context, id, encoded.mapping));
  const foreign = structuredClone(context);
  const tuple = JSON.parse(foreign.sources[0].ref);
  tuple[1] = "else";
  foreign.sources[0].ref = JSON.stringify(tuple);
  foreign.sources[0].scope.project = "else";
  foreign.reviews[0].scope.project = "else";
  assert.throws(() => encodeContext(foreign, id));
  assert.throws(() =>
    encodeContext(
      { ...context, sources: [context.sources[0], context.sources[0]] },
      id,
    ),
  );
  assert.throws(() =>
    encodeContext(
      {
        ...context,
        sources: [
          { ...context.sources[0], scope: { owner: "o", project: "else" } },
        ],
      },
      id,
    ),
  );
});
test("isolated oracle substitutions and leak controls do not affect frozen alias requests", async () => {
  const p = await run();
  assert.equal(p.cases.length, 8);
  assert.equal(p.oracleRulesChanged, 8);
  assert.equal(p.oracleWireUnchanged, true);
  assert.equal(p.leakChangedWireCount, 8);
  assert.equal(p.schemaChange, "none");
  assert.equal(p.sentToRealProvider, 0);
});
