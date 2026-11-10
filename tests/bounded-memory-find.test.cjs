"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBoundedFind,
} = require("../lib/generated/bounded-memory-find.cjs");
const {
  createBoundedTimeline,
  createBoundedEvidence,
} = require("../lib/generated/bounded-memory-read.cjs");

test("bounded find handles optional values and clamps the requested limit", async () => {
  const diagnostics = [];
  const calls = [];
  const find = createBoundedFind(
    (search) => {
      calls.push(search);
      return {
        topics: Array.from({ length: 6 }, (_, index) => ({
          topic: "T" + (index + 1),
          matchCount: index + 2,
          text: "synthetic hidden field",
        })),
        searchMayHaveMore: false,
      };
    },
    (diagnostic) => diagnostics.push(diagnostic),
  );

  for (const [args, search] of [
    [{}, { limit: 5 }],
    [{ keyword: null, limit: null }, { limit: 5 }],
    [{ keyword: "  \t", limit: 5 }, { limit: 5 }],
    [
      { keyword: "  合成：检索 / 主题?! ", limit: 20 },
      { keyword: "合成：检索 / 主题?!", limit: 5 },
    ],
    [
      { keyword: "🧪".repeat(60), limit: 1 },
      { keyword: "🧪".repeat(60), limit: 1 },
    ],
  ]) {
    const result = await find.run(args);
    assert.deepEqual(calls.at(-1), search);
    assert.deepEqual(result.coverage, {
      effectiveLimit: search.limit,
      returned: search.limit,
      searchMayHaveMore: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.topics[0].text, undefined);
  }
  assert.deepEqual(diagnostics.at(-1), {
    keyword: { type: "string", empty: false, characters: 60, utf8Bytes: 240 },
    limit: { type: "number", value: 1 },
    constraint: null,
    mcpDispatched: true,
    queryDispatched: true,
    effectiveLimit: 1,
    outcome: "found",
    count: 1,
  });
  assert.ok(!JSON.stringify(diagnostics).includes("合成"));
});

test("bounded find reports named rejections and normal empty results", async () => {
  let calls = 0;
  const diagnostics = [];
  const find = createBoundedFind(
    () => {
      calls++;
      return { topics: [], searchMayHaveMore: false };
    },
    (diagnostic) => diagnostics.push(diagnostic),
  );

  for (const [args, code] of [
    [null, "arguments-type"],
    [{ keyword: [] }, "keyword-type"],
    [{ keyword: "界".repeat(61), limit: 5 }, "keyword-max-length"],
    [{ limit: "5" }, "limit-type"],
    [{ limit: 5.5 }, "limit-type"],
    [{ limit: 0 }, "limit-minimum"],
    [{ limit: 10001 }, "limit-maximum"],
    [{ untrustedKey: "synthetic value" }, "additional-property"],
  ]) {
    assert.deepEqual(await find.run(args), {
      topics: [],
      coverage: { returned: 0 },
      error: { code },
    });
    assert.equal(diagnostics.at(-1).constraint, code);
    assert.equal(diagnostics.at(-1).outcome, "rejected");
    assert.equal(diagnostics.at(-1).count, 0);
    assert.equal(diagnostics.at(-1).mcpDispatched, true);
    assert.equal(diagnostics.at(-1).queryDispatched, false);
  }
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(diagnostics).includes("untrustedKey"));
  assert.deepEqual(await find.run({ keyword: "unmatched" }), {
    topics: [],
    coverage: { returned: 0, effectiveLimit: 5, searchMayHaveMore: false },
  });
  assert.equal(calls, 1);
  assert.equal(diagnostics.at(-1).outcome, "empty");
  assert.equal(diagnostics.at(-1).count, 0);
});

test("bounded find omits backend errors and malformed aliases from its result", async () => {
  const failed = {
    topics: [],
    coverage: { returned: 0, effectiveLimit: 5 },
    error: { code: "lookup-failed" },
  };
  for (const lookup of [
    () => Promise.reject(new Error("synthetic internal message")),
    () => ({
      topics: [{ topic: "synthetic title", matchCount: 1 }],
      searchMayHaveMore: false,
    }),
    () => ({
      topics: [{ topic: ["T1"], matchCount: 1 }],
      searchMayHaveMore: false,
    }),
  ]) {
    const diagnostics = [];
    assert.deepEqual(
      await createBoundedFind(lookup, (d) => diagnostics.push(d)).run({}),
      failed,
    );
    assert.deepEqual(diagnostics, [
      {
        keyword: { type: "missing" },
        limit: { type: "missing" },
        constraint: null,
        mcpDispatched: true,
        queryDispatched: true,
        effectiveLimit: 5,
        outcome: "lookup-failed",
        count: 0,
      },
    ]);
  }
});

test("bounded find reports a single outcome after asynchronous lookup", async () => {
  const diagnostics = [];
  let finish;
  const lookup = new Promise((resolve) => {
    finish = resolve;
  });
  const find = createBoundedFind(
    () => lookup,
    (d) => diagnostics.push(d),
  );
  const result = find.run({});
  assert.deepEqual(diagnostics, []);
  finish({
    topics: [{ topic: "T1", matchCount: 1 }],
    searchMayHaveMore: false,
  });
  await result;
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].outcome, "found");
  assert.equal(diagnostics[0].count, 1);
});

test("timeline advertises only the issued topic and recovers after bad input or lookup failure", async () => {
  let lookups = 0;
  const timeline = createBoundedTimeline(
    ({ topic }) => topic === "T1",
    async () => {
      if (lookups++ === 0) throw new Error("/synthetic/path: underlying error");
      return { rows: [] };
    },
  );
  assert.deepEqual(timeline.inputSchema, {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"],
    additionalProperties: false,
  });
  for (const args of [
    {},
    { topic: null },
    { topic: "T1", limit: 5 },
    { topic: "T1", offset: 0 },
  ]) {
    assert.deepEqual(await timeline.run(args), {
      error: { code: "invalid-arguments" },
    });
  }
  assert.deepEqual(await timeline.run({ topic: "T2" }), {
    error: { code: "topic-not-issued" },
  });
  assert.equal(lookups, 0);
  assert.deepEqual(await timeline.run({ topic: "T1" }), {
    error: { code: "lookup-failed" },
  });
  assert.deepEqual(await timeline.run({ topic: "T1" }), { rows: [] });
});

test("evidence requires the exact issued pair and never exposes a thrown message", async () => {
  let lookups = 0;
  const evidence = createBoundedEvidence(
    ({ id, revision }) => id === "E1" && revision === "V1",
    () => {
      if (lookups++ === 0) throw "synthetic internal message";
      return { excerpt: "fixture" };
    },
  );
  assert.deepEqual(evidence.inputSchema, {
    type: "object",
    properties: { id: { type: "string" }, revision: { type: "string" } },
    required: ["id", "revision"],
    additionalProperties: false,
  });
  for (const args of [
    { id: "E1" },
    { id: null, revision: "V1" },
    { id: "E1", revision: null },
    { id: "E1", revision: "V1", source: {} },
    { id: "E1", revision: "V1", limit: 5 },
    { id: "E1", revision: "V1", offset: 0 },
  ]) {
    assert.deepEqual(await evidence.run(args), {
      error: { code: "invalid-arguments" },
    });
  }
  assert.deepEqual(await evidence.run({ id: "E1", revision: "V2" }), {
    error: { code: "citation-not-issued" },
  });
  assert.equal(lookups, 0);
  assert.deepEqual(await evidence.run({ id: "E1", revision: "V1" }), {
    error: { code: "lookup-failed" },
  });
  assert.deepEqual(await evidence.run({ id: "E1", revision: "V1" }), {
    excerpt: "fixture",
  });
});
