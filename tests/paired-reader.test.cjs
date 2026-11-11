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
test("records received status, safe reason and usage even without a valid completed answer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paired-status-test-"));
  try {
    const cases = await construct(),
      output = path.join(dir, "result.json");
    let sent = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith("/stats"))
        return Response.json({
          requests: sent,
          requestedModel: "gpt-6-luna",
          requestedEffort: "low",
        });
      sent++;
      if (sent === 1)
        return Response.json({
          status: "incomplete",
          model: "gpt-6-luna",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 693, output_tokens: 512, total_tokens: 1205 },
          output: [{ content: [{ type: "output_text", text: "{invalid" }] }],
        });
      if (sent === 2)
        return Response.json({
          status: "failed",
          model: "gpt-6-luna",
          error: { code: "server_error", message: "do not save" },
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        });
      if (sent === 3)
        return Response.json(
          {
            error: "provider failed",
            provider: {
              providerStatus: "failed",
              errorCode: "server_error",
              usage: { input_tokens: 5, total_tokens: 5 },
            },
          },
          { status: 502 },
        );
      if (sent === 4)
        return Response.json({
          status: "incomplete",
          model: "gpt-6-luna",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
          output: { malformed: true },
        });
      if (sent === 5)
        return Response.json({
          status: "failed",
          model: "gpt-6-luna",
          error: { code: "server_error" },
          usage: { input_tokens: 5, total_tokens: 5 },
          output: [null],
        });
      return Response.json({
        status: "completed",
        model: "gpt-6-luna",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: '{"status":"unknown","facts":[{"value":null,"citations":[]},{"value":null,"citations":[]}]}',
              },
            ],
          },
        ],
      });
    };
    const result = await live(cases, [], output, {
      token: "synthetic",
      base: "http://127.0.0.1:8080",
      enabled: true,
      fetchImpl,
    });
    assert.equal(result.results[0].providerStatus, "incomplete");
    assert.equal(result.results[0].incompleteReason, "max_output_tokens");
    assert.equal(result.results[0].usage.total, 1205);
    assert.equal(result.results[0].answer, null);
    assert.equal(result.results[1].providerStatus, "failed");
    assert.equal(result.results[1].errorCode, "server_error");
    assert.equal(result.results[1].usage.total, 3);
    assert.equal(result.results[2].providerStatus, "failed");
    assert.equal(result.results[2].usage.total, 5);
    assert.equal(result.results[3].providerStatus, "incomplete");
    assert.equal(result.results[3].usage.total, 7);
    assert.equal(result.results[4].providerStatus, "failed");
    assert.equal(result.results[4].usage.total, 5);
    assert.equal(result.results[5].usage.total, null);
    assert.ok(!JSON.stringify(result).includes("do not save"));
    assert.equal(
      JSON.parse(await fs.readFile(output, "utf8")).results.length,
      8,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
