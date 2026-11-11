"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  construct,
  preflight,
  score,
  cleanUsage,
  live,
  counterfactual,
} = require("../benchmark/memory-views/paired-reader.cjs");
const fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const oracle = require("../benchmark/memory-views/paired-oracle.cjs");
test("four balanced pairs preserve context budget and freeze actual proxy wire independent of oracle", async () => {
  const cases = await construct();
  assert.equal(cases.length, 8);
  assert.deepEqual(
    cases.map((c) => c.arm),
    [
      "structured",
      "structured-bundle",
      "structured-bundle",
      "structured",
      "structured",
      "structured-bundle",
      "structured-bundle",
      "structured",
    ],
  );
  for (const c of cases) {
    assert.ok(c.context.sources.length <= 3);
    assert.ok(Buffer.byteLength(JSON.stringify(c.context)) <= 1900);
    const body = JSON.parse(c.body);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.reasoning.effort, "low");
    assert.ok(!Object.hasOwn(body, "tools"));
    assert.ok(!Object.hasOwn(body, "previous_response_id"));
  }
  const first = await preflight(cases),
    check = await counterfactual();
  assert.deepEqual(check.original.wire, first);
  assert.deepEqual(check.modified.wire, first);
  assert.notDeepEqual(check.original.assessment, check.modified.assessment);
  assert.equal(check.modified.changedRules, 8);
  assert.equal(check.leakDetected, true);
  assert.equal(check.leakChangedCount, 8);
});
test("scores refusal, omission, unsupported, semantic and citations separately", async () => {
  const cs = await construct(),
    get = (id, arm) => cs.find((c) => c.id === id && c.arm === arm);
  const bundle = get("dependency", "structured-bundle"),
    lexical = get("dependency", "structured");
  const response = (task, refs) => ({
    status: "partial",
    facts: [
      { value: task, citations: refs },
      { value: null, citations: [] },
    ],
  });
  assert.equal(
    score(
      bundle,
      response("Prepare checklist.", [
        bundle.refById.task,
        bundle.refById.relation,
      ]),
      oracle,
    ).items[0].outcome,
    "correct",
  );
  assert.equal(
    score(
      bundle,
      response("Something else", [
        bundle.refById.task,
        bundle.refById.relation,
      ]),
      oracle,
    ).items[0].outcome,
    "semantic-error",
  );
  assert.equal(
    score(bundle, response("Prepare checklist", [bundle.refById.task]), oracle)
      .items[0].outcome,
    "citation-error",
  );
  assert.equal(
    score(
      lexical,
      response("Prepare checklist", [
        lexical.refById.task,
        lexical.refById.relation,
      ]),
      oracle,
    ).items[0].outcome,
    "unsupported-assertion",
  );
  const empty = {
    status: "unknown",
    facts: [
      { value: null, citations: [] },
      { value: null, citations: [] },
    ],
  };
  assert.equal(score(bundle, empty, oracle).items[0].outcome, "omission");
  assert.equal(
    score(lexical, empty, oracle).items[0].outcome,
    "justified-refusal",
  );
  const wrongTime = structuredClone(bundle);
  wrongTime.context.reviews.find((r) => r.type === "dependency").knownAt =
    "2026-01-01T13:01:00Z";
  assert.equal(
    score(wrongTime, empty, oracle).items[0].outcome,
    "justified-refusal",
  );
  const beforeEvidence = structuredClone(bundle);
  beforeEvidence.context.reviews.find((r) => r.type === "dependency").knownAt =
    "2026-01-01T12:39:00Z";
  assert.equal(
    score(beforeEvidence, empty, oracle).items[0].outcome,
    "justified-refusal",
  );
  const wrongRoot = structuredClone(bundle);
  wrongRoot.context.reviews.find((r) => r.type === "dependency").decision =
    "UNRELATED";
  assert.equal(
    score(wrongRoot, empty, oracle).items[0].outcome,
    "justified-refusal",
  );
  const temporal = get("temporal-slot", "structured-bundle");
  const wrongRevision = structuredClone(temporal);
  wrongRevision.context.reviews.find((r) => r.type === "correction").revises =
    "UNRELATED";
  assert.equal(
    score(wrongRevision, empty, oracle).items[0].outcome,
    "justified-refusal",
  );
  assert.equal(
    score(
      bundle,
      {
        status: "unknown",
        facts: [
          { value: null, citations: ["bad"] },
          { value: null, citations: [] },
        ],
      },
      oracle,
    ).protocolError,
    true,
  );
  assert.equal(
    score(
      bundle,
      {
        status: "unknown",
        facts: [
          { value: null, citations: [], validAt: "x" },
          { value: null, citations: [] },
        ],
      },
      oracle,
    ).protocolError,
    true,
  );
  assert.deepEqual(
    cleanUsage({
      input_tokens: 4,
      output_tokens_details: { reasoning_tokens: 2 },
    }),
    {
      input: 4,
      output: null,
      total: null,
      cached: null,
      reasoning: 2,
      reported: {
        input_tokens: 4,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    },
  );
});
test("failed proxy precheck leaves all synthetic cases explicitly unsent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paired-failure-test-"));
  try {
    const cases = await construct(),
      result = path.join(dir, "result.json");
    await assert.rejects(
      live(cases, [], result, {
        token: "synthetic",
        base: "http://127.0.0.1:8080",
        enabled: true,
        fetchImpl: async () => new Response("{}", { status: 503 }),
      }),
      /proxy stats unavailable/,
    );
    const saved = JSON.parse(await fs.readFile(result, "utf8"));
    assert.equal(saved.runStatus, "proxy-stats-unavailable");
    assert.equal(saved.results.length, 8);
    assert.ok(saved.results.every((x) => x.status === "not-sent"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
