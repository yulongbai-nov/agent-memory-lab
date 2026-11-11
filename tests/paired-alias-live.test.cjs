"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  { createHash } = require("node:crypto");
const {
  constructAliases,
} = require("../benchmark/memory-views/paired-alias-preflight.cjs");
const {
  assessAlias,
  reserveLock,
  compareBaseline,
} = require("../benchmark/memory-views/paired-alias-live.cjs");
const {
  construct,
  preflight,
  live,
} = require("../benchmark/memory-views/paired-reader.cjs");
const { buildRequest } = require("../benchmark/harness-e2e/openai-proxy.cjs");
const hash = (x) => createHash("sha256").update(x).digest("hex");
test("aliases decode against their own case and arm; invalid citations are not accepted", async () => {
  const cases = await constructAliases(),
    x = cases.find(
      (s) => s.id === "temporal-slot" && s.arm === "structured-bundle",
    ),
    other = cases.find(
      (s) => s.id === "temporal-slot" && s.arm === "structured",
    );
  const alias = x.mapping.entries.find(
    (e) => e.ref === x.refById.clarify,
  ).alias;
  const answer = {
    status: "partial",
    facts: [
      { value: "Tuesday", citations: [alias] },
      { value: null, citations: [] },
    ],
  };
  const result = assessAlias(x, answer);
  assert.equal(result.assessment.items[0].outcome, "correct");
  assert.equal(result.decodedAnswer.facts[0].citations[0], x.refById.clarify);
  assert.equal(answer.facts[0].citations[0], alias);
  const foreign = other.mapping.entries[0].alias,
    wrong = structuredClone(answer);
  wrong.facts[0].citations = [foreign];
  const rejected = assessAlias(x, wrong);
  assert.equal(rejected.decodeErrors, 1);
  assert.equal(rejected.assessment.items[0].outcome, "citation-error");
  assert.notEqual(
    rejected.decodedAnswer.facts[0].citations[0],
    x.refById.clarify,
  );
});
test("all eight differ only in displayed reference serialization", async () => {
  const old = await construct(),
    oldWire = await preflight(old),
    baseline = old.map((s, i) => ({
      id: s.id,
      arm: s.arm,
      wireSha256: oldWire[i].sha256,
      wireBody: oldWire[i].body,
    }));
  const cases = await constructAliases(),
    wire = await preflight(cases);
  assert.equal(compareBaseline(cases, wire, baseline), true);
  const changed = structuredClone(baseline);
  const body = JSON.parse(changed[0].wireBody),
    input = JSON.parse(body.input);
  input.question += " changed";
  body.input = JSON.stringify(input);
  changed[0].wireBody = JSON.stringify(body);
  changed[0].wireSha256 = hash(changed[0].wireBody);
  assert.throws(
    () => compareBaseline(cases, wire, changed),
    /baseline question or evidence mismatch/,
  );
});
test("fake transport records all eight actual wire hashes and preserves invalid output usage", async () => {
  const cases = await constructAliases(),
    wire = await preflight(cases),
    frozen = cases.map((s, i) => ({
      id: s.id,
      arm: s.arm,
      wireSha256: wire[i].sha256,
    }));
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "alias-live-test-")),
    file = path.join(d, "result.json"),
    wireHashes = [];
  let calls = 0;
  try {
    const fetchImpl = async (url, opt) => {
      if (url.endsWith("/stats"))
        return Response.json({
          requests: calls,
          requestedModel: "gpt-6-luna",
          requestedEffort: "low",
          wireHashVersion: 1,
          wireHashes,
        });
      const actual = JSON.stringify(buildRequest(JSON.parse(opt.body)));
      wireHashes.push(hash(actual));
      calls++;
      if (calls === 2)
        return Response.json({
          status: "incomplete",
          model: "gpt-6-luna",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 693, output_tokens: 512, total_tokens: 1205 },
          output: [{ content: [{ type: "output_text", text: "{invalid" }] }],
        });
      return Response.json({
        status: "completed",
        model: "gpt-6-luna",
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
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
    const result = await live(cases, frozen, file, {
      enabled: true,
      token: "synthetic-gate-secret",
      base: "http://127.0.0.1:8080",
      fetchImpl,
      requireWireHashes: true,
      assess: assessAlias,
    });
    assert.equal(calls, 8);
    assert.equal(result.results.length, 8);
    assert.ok(
      result.results.every(
        (r, i) =>
          r.actualWireSha256 === wire[i].sha256 && r.wireVerified === true,
      ),
    );
    assert.equal(result.results[1].status, "unverified");
    assert.equal(result.results[1].providerStatus, "incomplete");
    assert.equal(result.results[1].incompleteReason, "max_output_tokens");
    assert.equal(result.results[1].usage.total, 1205);
    assert.equal(result.results[1].visibleText, "{invalid");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).results.length, 8);
    assert.ok(
      !(await fs.readFile(file, "utf8")).includes("synthetic-gate-secret"),
    );
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
});
test("hash mismatch stops future slots and lock refuses duplicates", async () => {
  const cases = await constructAliases(),
    wire = await preflight(cases),
    frozen = cases.map((s, i) => ({
      id: s.id,
      arm: s.arm,
      wireSha256: wire[i].sha256,
    }));
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "alias-lock-test-")),
    file = path.join(d, "result.json"),
    wireHashes = [];
  let calls = 0;
  try {
    const lock = await reserveLock("a".repeat(64), d);
    assert.equal((await fs.stat(lock)).mode & 0o777, 0o600);
    await assert.rejects(
      reserveLock("a".repeat(64), d),
      (e) => e.code === "EEXIST",
    );
    const fetchImpl = async (url) => {
      if (url.endsWith("/stats"))
        return Response.json({
          requests: calls,
          requestedModel: "gpt-6-luna",
          requestedEffort: "low",
          wireHashVersion: 1,
          wireHashes,
        });
      calls++;
      wireHashes.push("0".repeat(64));
      return Response.json({
        status: "completed",
        model: "gpt-6-luna",
        usage: { total_tokens: 2 },
        output: [],
      });
    };
    const result = await live(cases, frozen, file, {
      enabled: true,
      token: "synthetic",
      base: "http://127.0.0.1:8080",
      fetchImpl,
      requireWireHashes: true,
      assess: assessAlias,
    });
    assert.equal(calls, 1);
    assert.equal(result.runStatus, "wire-proof-failed");
    assert.equal(result.results[0].wireVerified, false);
    assert.equal(result.results[0].upstreamSent, true);
    assert.equal(result.results[0].proxyRequestsAfter, 1);
    assert.ok(result.results.slice(1).every((r) => r.status === "not-sent"));
    assert.equal(result.results[0].usage.total, 2);
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
});
test("missing proxy hash capability refuses before any provider request", async () => {
  const cases = await constructAliases(),
    wire = await preflight(cases),
    frozen = cases.map((s, i) => ({
      id: s.id,
      arm: s.arm,
      wireSha256: wire[i].sha256,
    })),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "alias-capability-test-"));
  let posted = 0;
  try {
    const file = path.join(dir, "result.json"),
      fetchImpl = async (url) => {
        if (url.endsWith("/stats"))
          return Response.json({
            requests: 0,
            requestedModel: "gpt-6-luna",
            requestedEffort: "low",
          });
        posted++;
        throw Error("must not post");
      };
    await assert.rejects(
      live(cases, frozen, file, {
        enabled: true,
        token: "synthetic",
        base: "http://127.0.0.1:8080",
        fetchImpl,
        requireWireHashes: true,
        assess: assessAlias,
      }),
      /proxy is not fresh or has wrong model/,
    );
    const result = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(posted, 0);
    assert.ok(result.results.every((x) => x.status === "not-sent"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
