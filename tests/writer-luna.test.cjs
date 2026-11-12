"use strict";
const test = require("node:test"),
  { URL } = require("node:url"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  { once } = require("node:events"),
  Ajv = require("ajv");
const {
  prepare,
  live,
  schema,
  mapOutput,
  hash,
} = require("../benchmark/writer-luna/run.cjs");
const canonical = require("../lib/candidate-contract-v2.cjs").OUTPUT_SCHEMA_V2;
const {
  createBudgetProxy,
} = require("../benchmark/harness-e2e/openai-proxy.cjs");
const freeze = require("../benchmark/writer-luna/freeze.json"),
  token = "synthetic-gate-token-for-writer-case";
test("frozen public bodies, disjoint wire schema, exact source and strict aliases", async () => {
  const slots = await prepare();
  assert.deepEqual(
    slots.map(({ id, wireSha256, wireBody }) => ({ id, wireSha256, wireBody })),
    freeze,
  );
  const ajv = new Ajv({ allErrors: true }),
    old = ajv.compile(canonical),
    wire = ajv.compile(schema),
    a = slots[0].aliases[0],
    ref = {
      source: a.source,
      item: a.item,
      version: a.version,
      quote: a.text.slice(0, 4),
    };
  const decision = {
      kind: "decision",
      basis: "confirmed",
      claim: "sample",
      evidence: [ref],
    },
    todo = { kind: "todo", claim: "sample", evidence: [ref] };
  for (const candidates of [
    [],
    [decision],
    [todo],
    [{ ...decision, kind: "todo" }],
    [{ ...todo, kind: "decision" }],
    [{ ...decision, basis: "wrong" }],
    [{ ...todo, evidence: [] }],
    [{ ...decision, extra: true }],
  ]) {
    const x = { protocol: "candidate-v2", candidates };
    assert.equal(Boolean(old(x)), Boolean(wire(x)));
  }
  const mapped = mapOutput(
    { protocol: "candidate-v2", candidates: [decision, todo] },
    slots[0].aliases,
    slots[0].records,
  );
  assert.equal(mapped.length, 2);
  assert.ok(
    mapped.every(
      (x) => x.status === "待核实" && x.evidence[0].originalSpan.originalSha256,
    ),
  );
  assert.throws(() =>
    mapOutput(
      {
        protocol: "candidate-v2",
        candidates: [{ ...todo, evidence: [{ ...ref, item: "unknown" }] }],
      },
      slots[0].aliases,
      slots[0].records,
    ),
  );
});
test("real budget proxy forwards frozen bytes and accounts incomplete/failed usage without retries", async (t) => {
  const testRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "synthetic-writer-test-"),
  );
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = testRoot;
  t.after(async () => {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await fs.rm(testRoot, { recursive: true, force: true });
  });
  const slots = await prepare(),
    dir = await fs.mkdtemp(
      path.join(
        await fs.realpath(os.tmpdir()),
        "synthetic-luna-writer-results-",
      ),
    );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let count = 0;
  const upstream = [];
  const proxy = createBudgetProxy({
    apiKey: "synthetic-key",
    gateToken: token,
    requestLimit: 4,
    outputTokens: 384,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      upstream.push(hash(init.body));
      assert.equal(body.max_output_tokens, 384);
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      count++;
      if (count === 1)
        return Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          model: "gpt-6-luna",
          usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
          output: [],
        });
      if (count === 2)
        return Response.json(
          {
            error: { code: "invalid_request_error" },
            usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
          },
          { status: 400 },
        );
      return Response.json({
        status: "completed",
        model: "gpt-6-luna",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text:
                  count === 3
                    ? "{bad json"
                    : '{"protocol":"candidate-v2","candidates":[]}',
              },
            ],
          },
        ],
      });
    },
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((r) => proxy.close(r)));
  const root = "http://127.0.0.1:" + proxy.address().port;
  const fetchImpl = (url, opts) => fetch(root + new URL(url).pathname, opts);
  const forged = structuredClone(slots);
  forged[0].records[0].source = "forged-source";
  await assert.rejects(
    live(forged, freeze, dir, token, { fetchImpl }),
    /source mapping mismatch/,
  );
  assert.equal(count, 0);
  const out = await live(slots, freeze, dir, token, { fetchImpl });
  assert.equal(out.status, "finished");
  assert.equal(count, 4);
  assert.deepEqual(
    upstream,
    freeze.map((x) => x.wireSha256),
  );
  assert.equal(out.results[0].providerStatus, "incomplete");
  assert.equal(out.results[0].usage.total_tokens, 13);
  assert.equal(out.results[1].providerErrorCode, "invalid_request_error");
  assert.equal(out.results[1].usage.total_tokens, 2);
  assert.equal(out.results[2].status, "invalid-output");
  assert.equal(out.results[2].providerStatus, "completed");
  assert.equal(out.results[2].usage.total_tokens, 2);
  assert.ok(out.results.every((x) => x.wireVerified));
  const secondDir = await fs.mkdtemp(
    path.join(testRoot, "synthetic-luna-writer-results-"),
  );
  await assert.rejects(
    live(slots, freeze, secondDir, token, { fetchImpl }),
    /EEXIST/,
  );
});
test("actual proxy retains model mismatch, lost-body usage, and visible refusal", async (t) => {
  const temp = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "synthetic-writer-test-"),
    ),
    prior = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(async () => {
    if (prior === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prior;
    await fs.rm(temp, { recursive: true, force: true });
  });
  const slots = await prepare(),
    dir = await fs.mkdtemp(path.join(temp, "synthetic-luna-writer-results-"));
  let count = 0;
  const proxy = createBudgetProxy({
    apiKey: "synthetic-key",
    gateToken: token,
    requestLimit: 4,
    outputTokens: 384,
    fetchImpl: async () => {
      count++;
      let content = [
        {
          type: "output_text",
          text: '{"protocol":"candidate-v2","candidates":[]}',
        },
      ];
      if (count === 3)
        content = [{ type: "refusal", refusal: "SYNTHETIC VISIBLE REFUSAL" }];
      return Response.json({
        status: "completed",
        model: "gpt-6-luna",
        ...(count === 1 ? { reasoning: { effort: "high" } } : {}),
        usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
        output: [
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "NEVER RETAIN" }],
          },
          { type: "message", role: "assistant", content },
        ],
      });
    },
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((r) => proxy.close(r)));
  const root = "http://127.0.0.1:" + proxy.address().port;
  let sent = 0;
  const fetchImpl = async (url, opts) => {
    const res = await fetch(root + new URL(url).pathname, opts);
    if (opts.method === "POST" && ++sent === 2) {
      await res.text();
      return {
        ok: true,
        json: async () => {
          throw Error("synthetic body lost");
        },
      };
    }
    return res;
  };
  const out = await live(slots, freeze, dir, token, { fetchImpl });
  assert.equal(out.results[0].status, "baseline-mismatch");
  assert.equal(out.results[0].reportedEffort, "high");
  assert.equal(out.results[0].requestedEffort, "low");
  assert.equal(out.results[1].status, "transport-failed");
  assert.equal(out.results[1].usage, null);
  assert.equal(out.results[1].proxyStats.usage.total_tokens.tokens, 44);
  assert.equal(out.results[2].status, "refused");
  assert.deepEqual(out.results[2].visibleOutput, [
    { type: "refusal", text: "SYNTHETIC VISIBLE REFUSAL" },
  ]);
  assert.equal(out.results[3].reportedEffort, null);
  assert.equal(out.proxyStats.usage.total_tokens.tokens, 88);
  assert.equal(out.proxyStats.unexpectedEffort, 1);
  assert(!JSON.stringify(out).includes("NEVER RETAIN"));
  assert.equal(count, 4);
});
test("result write failure preserves original error and final safe proxy statistics", async (t) => {
  const temp = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "synthetic-writer-test-"),
    ),
    prior = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(async () => {
    if (prior === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prior;
    await fs.rm(temp, { recursive: true, force: true });
  });
  const slots = await prepare(),
    dir = await fs.mkdtemp(path.join(temp, "synthetic-luna-writer-results-"));
  let count = 0;
  const proxy = createBudgetProxy({
    apiKey: "synthetic-key",
    gateToken: token,
    requestLimit: 4,
    outputTokens: 384,
    fetchImpl: async () => {
      count++;
      return Response.json({
        status: "completed",
        model: "gpt-6-luna",
        usage: { input_tokens: 11, output_tokens: 11, total_tokens: 22 },
        output: [],
      });
    },
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((r) => proxy.close(r)));
  const root = "http://127.0.0.1:" + proxy.address().port,
    fetchImpl = (url, opts) => fetch(root + new URL(url).pathname, opts),
    bad = Object.assign(Error("synthetic write failure"), { code: "EIO" });
  const saveImpl = async (file, value) => {
    if (count > 0) throw bad;
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  };
  await assert.rejects(
    live(slots, freeze, dir, token, { fetchImpl, saveImpl }),
    (e) => e === bad,
  );
  const receipt = JSON.parse(
    await fs.readFile(path.join(dir, "luna-writer-proxy-stats.json"), "utf8"),
  );
  assert.equal(receipt.proxyStats.usage.total_tokens.tokens, 22);
  assert.equal(receipt.proxyStats.requests, 1);
  assert.equal(count, 1);
});
test("fallback write failure emits safe stats without masking original error", async (t) => {
  const temp = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "synthetic-writer-test-"),
    ),
    prior = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(async () => {
    if (prior === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prior;
    await fs.rm(temp, { recursive: true, force: true });
  });
  const slots = await prepare(),
    dir = await fs.mkdtemp(path.join(temp, "synthetic-luna-writer-results-")),
    primary = Object.assign(Error("synthetic EIO"), { code: "EIO" });
  let fallback,
    fetchCount = 0;
  const fetchImpl = async (url) => {
    assert.equal(new URL(url).pathname, "/stats");
    fetchCount++;
    return Response.json({
      requests: 0,
      usage: { total_tokens: { reported: 0, tokens: null } },
      secret: "DO NOT RETAIN",
    });
  };
  await assert.rejects(
    live(slots, freeze, dir, token, {
      fetchImpl,
      saveImpl: async () => {
        throw primary;
      },
      fallbackImpl: async () => {
        throw Error("fallback failed");
      },
      reportStats: (value) => {
        fallback = value;
      },
    }),
    (e) => e === primary,
  );
  assert.equal(fetchCount, 1);
  assert.equal(fallback.status, "runner-failed");
  assert.equal(fallback.proxyStats.requests, 0);
  assert(!JSON.stringify(fallback).includes("DO NOT RETAIN"));
});
