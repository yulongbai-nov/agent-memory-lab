"use strict";
// Synthetic-only paired reader. Default and --preflight use an in-process fake upstream.
const fs = require("node:fs/promises");
const { mkdtemp, rm } = fs;
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { fork } = require("node:child_process");
const {
  seed,
  makeCorpus,
  buildViews,
  handle,
  selectEvidence,
  scope,
  topic,
} = require("./run.cjs");
const { selectEvidenceBundle } = require("./evidence-bundle.cjs");
const held = require("./paired-fixtures.cjs");
const {
  createBudgetProxy,
  LIMITS,
} = require("../harness-e2e/openai-proxy.cjs");
const { score } = require("./paired-score.cjs");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const limits = { topK: 3, contextBytes: 1900 };
const instruction =
  "Answer only from the supplied synthetic evidence. A correction clarifies an earlier interpretation; a change becomes effective at its stated time. Use the requested order. For each unsupported item return null with no citations. Cite exact source references from the supplied rows only. status is resolved for two values, partial for one, and unknown for zero.";
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "facts"],
  properties: {
    status: { type: "string", enum: ["resolved", "partial", "unknown"] },
    facts: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "citations"],
        properties: {
          value: { type: ["string", "null"] },
          citations: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};
const specifications = require("./retrieval-spec.json");
async function construct() {
  const dir = await mkdtemp(join(tmpdir(), "paired-memory-fixture-"));
  try {
    const fixture = await seed(dir, true),
      corpus = await makeCorpus(dir, fixture),
      views = await buildViews(dir, fixture, corpus);
    const rows = await views.structured();
    const spec = (id) => specifications.find((x) => x.id === id);
    const h1 = held.temporalFixture(false),
      h2 = held.dependencyFixture(false);
    const cases = [
      {
        ...spec("temporal-slot"),
        scope,
        topic,
        rows,
        refById: Object.fromEntries(
          [...fixture.refs].map(([id, ref]) => [id, handle(ref)]),
        ),
      },
      {
        ...spec("dependency"),
        scope,
        topic,
        rows,
        refById: Object.fromEntries(
          [...fixture.refs].map(([id, ref]) => [id, handle(ref)]),
        ),
        asOf: spec("dependency").request.asOf,
        knowledgeCutoff: spec("dependency").request.knowledgeCutoff,
        decisionRootId: "decision",
      },
      {
        id: "held-temporal",
        text: "Looking back from 13:00 UTC, which print handover location was active at 11:59 UTC and at 12:30 UTC?",
        scope: held.scope,
        topic: held.topic,
        rows: h1.rows,
        request: {
          kind: "temporal-comparison",
          validTimes: [held.time("11:59"), held.time("12:30")],
          retrospective: true,
        },
        refById: { old: h1.old, clarify: h1.clarify, change: h1.change },
      },
      {
        id: "held-dependency",
        text: "At 12:30 UTC, using knowledge through 13:00 UTC, what open work depends on the active print location? Return the work first and the location second.",
        scope: held.scope,
        topic: held.topic,
        rows: h2.rows,
        request: {
          kind: "open-dependency",
          asOf: held.time("12:30"),
          knowledgeCutoff: held.time("13:00"),
        },
        refById: { task: h2.task, relation: h2.relation, changed: h2.changed },
        asOf: held.time("12:30"),
        knowledgeCutoff: held.time("13:00"),
        decisionRootId: h2.rows.find((r) => r.type === "decision").id,
      },
    ];
    return cases.flatMap((c, i) =>
      (i % 2
        ? ["structured-bundle", "structured"]
        : ["structured", "structured-bundle"]
      ).map((arm) => {
        const context =
          arm === "structured"
            ? selectEvidence({ text: c.text }, c.rows, {
                scope: c.scope,
                topic: c.topic,
                limits,
              })
            : selectEvidenceBundle({
                scope: c.scope,
                topic: c.topic,
                request: c.request,
                rows: c.rows,
                limits,
              }).context;
        if (
          context.sources.length > 3 ||
          Buffer.byteLength(JSON.stringify(context)) > 1900
        )
          throw Error("context budget");
        const body = JSON.stringify({
          model: "gpt-6-luna",
          reasoning: { effort: "low" },
          instructions: instruction,
          input: JSON.stringify({ question: c.text, evidence: context }),
          stream: false,
          text: {
            format: {
              type: "json_schema",
              name: "paired_memory_answer",
              strict: true,
              schema,
            },
          },
        });
        return {
          id: c.id,
          arm,
          context,
          body,
          refById: c.refById,
          asOf: c.asOf,
          knowledgeCutoff: c.knowledgeCutoff,
          decisionRootId: c.decisionRootId,
        };
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function preflight(cases) {
  const gate = "paired-synthetic-gate-0123456789",
    wire = [];
  const fake = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (
      body.model !== "gpt-6-luna" ||
      body.reasoning?.effort !== "low" ||
      body.stream !== false ||
      body.store !== false ||
      body.max_output_tokens !== 512 ||
      body.tools !== undefined ||
      body.previous_response_id !== undefined ||
      body.conversation !== undefined
    )
      throw Error("unsafe synthetic upstream body");
    wire.push({ sha256: hash(init.body), body: init.body });
    return new Response(
      JSON.stringify({
        status: "completed",
        model: "gpt-6-luna",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  status: "unknown",
                  facts: [
                    { value: null, citations: [] },
                    { value: null, citations: [] },
                  ],
                }),
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const proxy = createBudgetProxy({
    apiKey: "synthetic-only",
    gateToken: gate,
    fetchImpl: fake,
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${proxy.address().port}/v1/responses`;
    for (const sample of cases) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${gate}`,
          "content-type": "application/json",
        },
        body: sample.body,
      });
      if (!res.ok) throw Error("fake proxy rejected request");
      await res.arrayBuffer();
    }
    if (wire.length !== 8) throw Error("incomplete fake forwarding");
    return wire;
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
}
function protocolAnswer(out) {
  const text = out.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (typeof text !== "string") throw Error("missing output text");
  return JSON.parse(text);
}
function cleanUsage(u) {
  const number = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
  function numericTree(x) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return {};
    return Object.fromEntries(
      Object.entries(x).flatMap(([k, v]) =>
        Number.isSafeInteger(v) && v >= 0
          ? [[k, v]]
          : v && typeof v === "object" && !Array.isArray(v)
            ? [[k, numericTree(v)]]
            : [],
      ),
    );
  }
  return {
    input: number(u?.input_tokens),
    output: number(u?.output_tokens),
    total: number(u?.total_tokens),
    cached: number(u?.input_tokens_details?.cached_tokens),
    reasoning: number(u?.output_tokens_details?.reasoning_tokens),
    reported: u ? numericTree(u) : null,
  };
}
async function live(cases, frozen, resultFile, options = {}) {
  const token = options.token ?? process.env.MEMLAB_PROXY_TOKEN,
    base = options.base ?? process.env.MEMLAB_PROXY_URL,
    send = options.fetchImpl ?? fetch,
    enabled = options.enabled ?? process.env.MEMLAB_PAIRED_REAL === "1";
  if (!enabled || !token || base !== "http://127.0.0.1:8080")
    throw Error("bounded local proxy or explicit live enablement unavailable");
  const reserved = await fs.open(resultFile, "wx", 0o600);
  await reserved.close();
  let runStatus = "preparing";
  const results = cases.map((s) => ({
      id: s.id,
      arm: s.arm,
      status: "not-sent",
      usage: cleanUsage(null),
    })),
    deadline = Date.now() + 360000;
  const persist = async () => {
    const data = Buffer.from(
      JSON.stringify({ runStatus, frozen, results }, null, 2) + "\n",
    );
    const temp = `${resultFile}.${require("node:crypto").randomBytes(12).toString("hex")}.tmp`;
    const file = await fs.open(temp, "wx", 0o600);
    try {
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temp, resultFile);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
  };
  const proxyStats = async () => {
    const response = await send(base + "/stats", {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw Error("proxy stats unavailable");
    return response.json();
  };
  try {
    await persist();
    let initial;
    try {
      initial = await proxyStats();
    } catch {
      runStatus = "proxy-stats-unavailable";
      await persist();
      throw Error("proxy stats unavailable");
    }
    if (
      initial.requests !== 0 ||
      initial.requestedModel !== "gpt-6-luna" ||
      initial.requestedEffort !== "low"
    ) {
      runStatus = "proxy-not-fresh-or-wrong-model";
      await persist();
      throw Error("proxy is not fresh or has wrong model");
    }
    runStatus = "running";
    let previousCount = 0;
    await persist();
    for (const [i, sample] of cases.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        results[i].status = "not-sent-deadline";
        continue;
      }
      const begin = Date.now();
      results[i] = {
        id: sample.id,
        arm: sample.arm,
        status: "attempting",
        upstreamSent: null,
        usage: cleanUsage(null),
      };
      await persist();
      const budget = deadline - Date.now();
      if (budget <= 0) {
        results[i].status = "not-sent-deadline";
        await persist();
        continue;
      }
      try {
        const response = await send(base + "/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: sample.body,
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(75000, budget)),
        });
        if (!response.ok) {
          await response.body?.cancel();
          results[i] = {
            ...results[i],
            status: `http-${response.status}`,
            elapsedMs: Date.now() - begin,
          };
        } else {
          const out = await response.json();
          const visibleText =
            out.output
              ?.flatMap((item) => item.content ?? [])
              .find((item) => item.type === "output_text")?.text ?? null;
          let answer = null;
          try {
            answer = protocolAnswer(out);
          } catch {
            /* preserve visible invalid response for regrading */
          }
          const status =
            out.status === "completed" &&
            /^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(out.model || "") &&
            (!out.reasoning?.effort || out.reasoning.effort === "low")
              ? "completed"
              : "unverified";
          results[i] = {
            ...results[i],
            status,
            elapsedMs: Date.now() - begin,
            model: out.model ?? null,
            reportedEffort: out.reasoning?.effort ?? null,
            visibleText,
            answer,
            usage: cleanUsage(out.usage),
            assessment:
              status === "completed"
                ? score(sample, answer, require("./paired-oracle.cjs"))
                : null,
          };
        }
      } catch {
        results[i] = {
          ...results[i],
          status: "transport-or-format-error",
          elapsedMs: Date.now() - begin,
        };
      }
      // Count from the proxy, not from a local fetch attempt; if stats fail, preserve unknown.
      try {
        const stats = await proxyStats();
        const count = stats.requests;
        results[i].proxyRequestsAfter = count;
        if (
          Number.isSafeInteger(count) &&
          previousCount !== null &&
          (count === previousCount || count === previousCount + 1)
        )
          results[i].upstreamSent = count === previousCount + 1;
        previousCount = Number.isSafeInteger(count) ? count : null;
      } catch {
        results[i].proxyRequestsAfter = null;
        previousCount = null;
      }
      await persist();
    }
    runStatus = "finished";
    await persist();
    return { runStatus, frozen, results };
  } finally {
    /* each result snapshot is atomically replaced */
  }
}
function oracleWorker(variant, leak = false) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      ["PATH", "HOME", "NODE_PATH", "LANG", "TMPDIR"]
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]]),
    );
    const child = fork(
      join(__dirname, "paired-oracle-worker.cjs"),
      [variant, leak ? "leak" : "normal"],
      { env, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    let result,
      done = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Error("oracle worker timeout"));
    }, 30000);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    }
    child.on("message", (message) => {
      result = message;
    });
    child.on("error", () => finish(Error("oracle worker failed")));
    child.on("exit", (code) =>
      finish(code === 0 && result?.ok ? null : Error("oracle worker failed")),
    );
  });
}
async function counterfactual() {
  const original = await oracleWorker("original"),
    modified = await oracleWorker("modified");
  if (modified.changedRules !== 8)
    throw Error("not all oracle items were replaced");
  if (
    JSON.stringify(original.assessment) === JSON.stringify(modified.assessment)
  )
    throw Error("oracle counterfactual did not change scoring");
  if (JSON.stringify(original.wire) !== JSON.stringify(modified.wire))
    throw Error("wire body changed across actual oracle replacement");
  const leakOriginal = await oracleWorker("original", true),
    leakModified = await oracleWorker("modified", true);
  const leakChangedCount = leakOriginal.wire.filter(
    (wire, i) => wire.sha256 !== leakModified.wire[i]?.sha256,
  ).length;
  if (leakChangedCount !== 8)
    throw Error(
      "oracle leak negative control was not detected for all requests",
    );
  return { original, modified, leakDetected: true, leakChangedCount };
}
async function run(mode, artifact, resultFile) {
  const checked = await counterfactual();
  const samples = await construct();
  const first = await preflight(samples);
  if (JSON.stringify(first) !== JSON.stringify(checked.original.wire))
    throw Error("parent wire differs from isolated freeze");
  const frozen = samples.map((s, i) => ({
    id: s.id,
    arm: s.arm,
    wireSha256: first[i].sha256,
    wireBody: first[i].body,
    context: s.context,
  }));
  const pre = {
    schemaVersion: 1,
    mode: "zero-model",
    model: "gpt-6-luna",
    effort: "low",
    oracleCounterfactualChangedScore: true,
    oracleCounterfactual: {
      before: checked.original.assessment,
      after: checked.modified.assessment,
    },
    actualOracleReplacement: "isolated-process-module-cache",
    oracleItemsChanged: checked.modified.changedRules,
    intentionalOracleLeakDetected: checked.leakDetected,
    intentionalOracleLeakChangedWireCount: checked.leakChangedCount,
    wireUnchanged: true,
    sentToRealProvider: 0,
    cases: frozen,
  };
  if (mode === "--live") {
    const prior = JSON.parse(await fs.readFile(artifact, "utf8"));
    if (
      JSON.stringify(prior.cases) !== JSON.stringify(frozen) ||
      !prior.wireUnchanged ||
      !prior.oracleCounterfactualChangedScore ||
      !prior.intentionalOracleLeakDetected ||
      prior.oracleItemsChanged !== 8 ||
      prior.actualOracleReplacement !== "isolated-process-module-cache"
    )
      throw Error("preflight freeze mismatch");
    return live(samples, frozen, resultFile);
  }
  if (artifact)
    await fs.writeFile(artifact, JSON.stringify(pre, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  return pre;
}
if (require.main === module) {
  const [mode = "--preflight", artifact, resultFile] = process.argv.slice(2);
  if (
    !["--preflight", "--live"].includes(mode) ||
    process.argv.length > 5 ||
    (mode === "--preflight" && resultFile) ||
    (mode === "--live" && (!artifact || !resultFile))
  ) {
    console.error(
      "Use --preflight [output] or --live frozen-preflight result-file",
    );
    process.exitCode = 2;
  } else
    run(mode, artifact, resultFile)
      .then(async (out) => {
        if (mode === "--live") {
          console.log(
            JSON.stringify({
              mode,
              results: out.results.length,
              artifact: resultFile,
            }),
          );
        } else console.log(JSON.stringify(out, null, 2));
      })
      .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
      });
}
module.exports = {
  construct,
  preflight,
  score,
  cleanUsage,
  run,
  schema,
  live,
  counterfactual,
};
