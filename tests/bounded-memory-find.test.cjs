"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createBoundedFind,
} = require("../lib/generated/bounded-memory-find.cjs");

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
    assert.deepEqual(await createBoundedFind(lookup, () => {}).run({}), failed);
  }
});
