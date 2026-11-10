"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const sync = require("node:fs");
const { execFileSync, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { functionToolCatalog } = require("./recall.cjs");

const dryQuestion =
  "Find the synthetic release checklist and verify one fixture citation.";
const dryInstructions =
  "Use the synthetic memory tools. Zero matches and named tool errors are recoverable.";
const secretSentinel = "SYNTHETIC_BACKEND_SECRET_DO_NOT_FORWARD";
const json = JSON.stringify;
const finalSchema = {
  type: "object",
  properties: { excerpt: { type: "string" } },
  required: ["excerpt"],
  additionalProperties: false,
};

async function openSyntheticBackend(repo, archive) {
  const { operations } = require(path.join(repo, "lib/operations.cjs"));
  const op = await operations({
    dir: archive,
    owner: "local",
    project: "demo",
    readOnly: true,
  });
  const topic = "Release checklist";
  let firstTimeline = true;
  let firstEvidence = true;
  return {
    async find(keyword) {
      if (keyword === "synthetic-lookup-failure")
        throw new Error(secretSentinel);
      const result = await op.find({ keyword, limit: 5 });
      const hit = result.topics.find((row) => row.topic === topic);
      return {
        topics: hit ? [{ topic: "T1", matchCount: hit.count }] : [],
        coverage: { searchMayHaveMore: result.coverage.has_more },
      };
    },
    async timeline() {
      if (firstTimeline) {
        firstTimeline = false;
        throw new Error("/synthetic/timeline/" + secretSentinel);
      }
      const result = await op.timeline({ topic, limit: 20 });
      return {
        scanned: result.rows.length,
        eligible: result.rows.map((row, index) => ({
          row,
          ref: "E" + (index + 1),
          quote: { clean: "synthetic release fixture" },
        })),
      };
    },
    async evidence(ref, entries) {
      if (firstEvidence) {
        firstEvidence = false;
        throw new Error("/synthetic/evidence/" + secretSentinel);
      }
      const entry = entries.find((row) => row.ref === ref);
      const result = await op.evidence(entry.row.citation);
      return { ref, at: entry.row.time, excerpt: result.text, redacted: false };
    },
  };
}
const syntheticFinds = [
  {
    args: { keyword: " 合成 / 查找?! ", limit: 5 },
    outcome: "empty",
    count: 0,
    limit: 5,
  },
  {
    args: { keyword: "🧪".repeat(61), limit: 5 },
    outcome: "rejected",
    count: 0,
    code: "keyword-max-length",
  },
  {
    args: { keyword: "synthetic-lookup-failure" },
    outcome: "lookup-failed",
    count: 0,
    limit: 5,
    code: "lookup-failed",
  },
  { args: { keyword: null, limit: 20 }, outcome: "found", count: 1, limit: 5 },
  { args: {}, outcome: "found", count: 1, limit: 5 },
];
const timelineOutcomes = [
  "invalid-arguments",
  "invalid-arguments",
  "invalid-arguments",
  "topic-not-issued",
  "lookup-failed",
  null,
];
const evidenceOutcomes = [
  "invalid-arguments",
  "citation-not-issued",
  "lookup-failed",
  null,
];
const syntheticRequests =
  syntheticFinds.length + timelineOutcomes.length + evidenceOutcomes.length + 1;
function fakeProvider(repo, { model, toolCatalog, sse }) {
  const Ajv = require(path.join(repo, "node_modules/ajv"));
  const ajv = new Ajv();
  const tools = toolCatalog();
  const validators = new Map(
    tools[0].tools.map((fn) => [fn.name, ajv.compile(fn.parameters)]),
  );
  let i = 0,
    topic,
    citation,
    answer;
  return {
    send: async (wire) => {
      assert.ok(
        !wire.includes(secretSentinel),
        "backend sentinel leaked into model input",
      );
      const body = JSON.parse(wire),
        lookup = (n) =>
          JSON.parse(
            body.input.find(
              (x) =>
                x.type === "function_call_output" &&
                x.call_id === "call_fixture_" + n,
            ).output,
          );
      const findCount = syntheticFinds.length,
        timelineEnd = findCount + timelineOutcomes.length;
      assert.deepEqual(body.tools, tools);
      assert.equal(body.instructions, dryInstructions);
      assert.deepEqual(
        body.input.filter((x) => x.role === "user"),
        [{ role: "user", content: dryQuestion }],
      );
      let call, valid;
      if (i > 0 && i <= findCount) {
        const vector = syntheticFinds[i - 1],
          got = lookup(i - 1);
        assert.equal(got.topics.length, vector.count);
        assert.equal(got.coverage.returned, vector.count);
        assert.equal(got.coverage.effectiveLimit, vector.limit);
        assert.equal(got.error?.code, vector.code);
      }
      if (i > findCount) {
        const codes = i <= timelineEnd ? timelineOutcomes : evidenceOutcomes;
        const idx = i - (i <= timelineEnd ? findCount : timelineEnd) - 1,
          code = codes[idx];
        if (code) assert.deepEqual(lookup(i - 1), { error: { code } });
      }
      if (i < findCount) {
        const v = syntheticFinds[i];
        call = ["memory_find", v.args];
        valid = v.outcome !== "rejected";
      } else if (i < timelineEnd) {
        if (i === findCount) topic = lookup(i - 1).topics[0].topic;
        const idx = i - findCount;
        const args = [
          { topic: null },
          { topic, limit: 5 },
          { topic, offset: 0 },
          { topic: "unissued" },
          { topic },
          { topic },
        ][idx];
        call = ["memory_timeline", args];
        valid = idx >= 3;
      } else if (i < syntheticRequests - 1) {
        if (i === timelineEnd) citation = lookup(i - 1).rows[0].citation;
        const idx = i - timelineEnd;
        const args = [
          { id: citation.id, revision: null },
          { id: citation.id, revision: "unissued" },
          citation,
          citation,
        ][idx];
        call = ["memory_evidence", args];
        valid = idx > 0;
      } else {
        const got = lookup(i - 1);
        assert.equal(got.ref, citation.id);
        assert.ok(got.excerpt);
        answer = json({ excerpt: got.excerpt });
      }
      assert.ok(i < syntheticRequests, "unexpected synthetic turn");
      if (call) assert.equal(validators.get(call[0])(call[1]), valid);
      const output = call
        ? [
            {
              type: "reasoning",
              id: "rs_fixture_" + i,
              summary: [],
              encrypted_content: "fixture_encrypted_" + i,
            },
            {
              type: "function_call",
              id: "fc_fixture_" + i,
              call_id: "call_fixture_" + i,
              namespace: "mcp__memory",
              name: call[0],
              arguments: json(call[1]),
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: "msg_fixture",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: answer, annotations: [] }],
            },
          ];
      return sse({
        id: "resp_fixture_" + i++,
        object: "response",
        created_at: 1767225600,
        status: "completed",
        model,
        output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
    expected: () => answer,
  };
}
function validateDrySafety(
  ledger,
  binding,
  { model, createBoundedRelay, toolReceipt, sse, limit },
) {
  const g = createBoundedRelay(ledger, binding);
  const base = {
    model,
    reasoning: { effort: "low" },
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: binding.prompt }],
      },
    ],
  };
  assert.throws(
    () =>
      g.body({
        ...base,
        input: [
          ...base.input,
          { type: "future_item", secret: "fixture-not-authorized" },
        ],
      }),
    /unknown-input-item/,
  );
  assert.throws(
    () =>
      g.body({
        ...base,
        input: [
          ...base.input,
          {
            type: "function_call_output",
            call_id: "made_up",
            output: "fixture",
          },
        ],
      }),
    /unpaired-tool-output/,
  );
  assert.throws(
    () =>
      g.body({
        ...base,
        input: [
          ...base.input,
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "unapproved extra content" }],
          },
        ],
      }),
    /unknown-user-content/,
  );
  assert.equal(g.summary().forwarded, 0);
  const syntheticReceipts = [
    [
      "memory_find",
      { keyword: null, limit: 20 },
      {
        topics: [],
        coverage: { returned: 0, effectiveLimit: 5, searchMayHaveMore: false },
      },
    ],
    ["memory_timeline", { topic: "T1" }, { topic: "T1", rows: [] }],
    [
      "memory_evidence",
      { id: "E1", revision: "V1" },
      { error: { code: "citation-not-issued" } },
    ],
  ];
  for (const [name, args, output] of syntheticReceipts) {
    const methodLedger = ledger + ".dry-" + name;
    sync.writeFileSync(
      methodLedger,
      json({
        tool: name,
        proof: toolReceipt(name, args, output, binding.argumentKey),
      }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    const methodGate = createBoundedRelay(methodLedger, binding);
    const call = {
      type: "function_call",
      id: "fc_binding",
      call_id: "call_binding",
      namespace: "mcp__memory",
      name,
      arguments: json(args),
    };
    methodGate.response(
      sse({ id: "resp_binding", status: "completed", model, output: [call] }),
      true,
    );
    const reply = (candidate, value) => ({
      type: "function_call_output",
      call_id: candidate.call_id,
      output: [
        { type: "input_text", text: "Wall time: 0 seconds" },
        { type: "input_text", text: json(value) },
      ],
    });
    const withCall = (candidate, value) => ({
      ...base,
      input: [...base.input, candidate, reply(candidate, value)],
    });
    assert.throws(
      () =>
        methodGate.body(
          withCall({ ...call, arguments: json({ ...args, extra: 1 }) }, output),
        ),
      /unissued-function-call/,
    );
    assert.throws(
      () => methodGate.body(withCall(call, { ...output, extra: "forged" })),
      /tool-output-not-issued/,
    );
    assert.equal(methodGate.summary().forwarded, 0);
    methodGate.body(withCall(call, output));
    assert.equal(methodGate.summary().forwarded, 1);
    const replay = { ...call, id: "fc_replay", call_id: "call_replay" };
    methodGate.response(
      sse({ id: "resp_replay", status: "completed", model, output: [replay] }),
      true,
    );
    assert.throws(
      () => methodGate.body(withCall(replay, output)),
      /tool-output-not-issued/,
    );
  }
  const overflowLedger = ledger + ".dry-overflow";
  const args = { id: "E1", revision: "V1" },
    output = {
      ref: "E1",
      at: "fixture",
      excerpt: "x".repeat(512),
      redacted: false,
    };
  const receipt =
    json({
      tool: "memory_evidence",
      proof: toolReceipt("memory_evidence", args, output, binding.argumentKey),
    }) + "\n";
  sync.writeFileSync(overflowLedger, receipt.repeat(10), {
    mode: 0o600,
    flag: "wx",
  });
  const cap = createBoundedRelay(overflowLedger, binding);
  let i = 0,
    refused = false;
  for (; i < 10; i++) {
    const c = {
      type: "function_call",
      id: "fc_budget_" + i,
      call_id: "call_budget_" + i,
      namespace: "mcp__memory",
      name: "memory_evidence",
      arguments: json(args),
    };
    cap.response(
      sse({ id: "resp_budget_" + i, status: "completed", model, output: [c] }),
      i === 0,
    );
    try {
      cap.body({
        ...base,
        input: [
          ...base.input,
          c,
          {
            type: "function_call_output",
            call_id: c.call_id,
            output: [
              { type: "input_text", text: "Wall time: 0 seconds" },
              { type: "input_text", text: json(output) },
            ],
          },
        ],
      });
    } catch (e) {
      assert.equal(e.safeCode, "aggregate-quote-budget");
      refused = true;
      break;
    }
  }
  assert.ok(refused && cap.summary().conservativeExcerptBytes <= limit);
  return {
    unknownInputDenied: true,
    unissuedOutputDenied: true,
    unexpectedUserContentDenied: true,
    tamperedArgumentsDeniedForAllTools: true,
    forgedOutputDeniedForAllTools: true,
    reusedReceiptDeniedForAllTools: true,
    cumulativeCapDenied: true,
    approvedBeforeRefusal: cap.summary().forwarded,
  };
}

async function runReplay(repo, mcpEntry = __filename) {
  const shared = require(path.join(repo, "lib/bounded-memory-relay.cjs"));
  const { model, names, createBoundedRelay, listenBoundedRelay, toolCatalog } =
    shared;
  const work = await fs.mkdtemp(path.join(tmpdir(), "memlab-read-contract-"));
  const archive = path.join(work, "archive");
  const ledger = path.join(work, "receipts.jsonl");
  const argumentKey = randomBytes(32).toString("hex");
  const binding = {
    argumentKey,
    prompt: dryQuestion,
    runInstructions: dryInstructions,
    finalSchema,
  };
  const token = randomBytes(24).toString("hex");
  let listener, relay, nativeTools;
  try {
    const cfg = path.join(work, "mcp.json");
    const schemaPath = path.join(work, "schema.json");
    const instructionPath = path.join(work, "instructions.txt");
    const answerPath = path.join(work, "answer.json");
    for (const [file, value] of [
      [cfg, json({ repo, archive, ledger, argumentKey, dry: true })],
      [schemaPath, json(finalSchema)],
      [instructionPath, dryInstructions],
      [ledger, ""],
    ])
      await fs.writeFile(file, value, { mode: 0o600, flag: "wx" });
    execFileSync(
      process.execPath,
      [path.join(repo, "bin/seed-demo.cjs"), archive],
      {
        stdio: "ignore",
        timeout: 10000,
      },
    );

    const safety = validateDrySafety(ledger, binding, shared);
    const provider = fakeProvider(repo, shared);
    const catalog = await functionToolCatalog(work);
    relay = createBoundedRelay(ledger, binding);
    listener = await listenBoundedRelay({
      relay,
      send: provider.send,
      token,
      observe(raw) {
        assert.ok(!json(raw).includes(secretSentinel));
        if (nativeTools) return;
        const namespace = raw.tools?.find(
          (tool) => tool.type === "namespace" && tool.name === "mcp__memory",
        );
        const advertised = toolCatalog()[0].tools;
        assert.equal(namespace?.tools.length, names.length);
        nativeTools = advertised.map(({ name, description, parameters }) => {
          const native = namespace.tools.find(
            (tool) => tool.type === "function" && tool.name === name,
          );
          assert.equal(native?.strict, false);
          assert.equal(native.description, description);
          assert.deepEqual(native.parameters, {
            ...parameters,
            properties: Object.fromEntries(
              Object.entries(parameters.properties).map(([key, value]) => [
                key,
                { type: value.type },
              ]),
            ),
          });
          return { name, parameters: native.parameters, strict: native.strict };
        });
      },
    });

    await fs.writeFile(
      path.join(work, "config.toml"),
      `
model_provider = "fixture"
model_catalog_json = ${json(catalog)}
model_instructions_file = ${json(instructionPath)}
[mcp_servers.memory]
command = ${json(process.execPath)}
args = ${json([mcpEntry, "--mcp", cfg])}
required = true
enabled_tools = ${json(names)}
default_tools_approval_mode = "approve"
[model_providers.fixture]
name = "fixture"
base_url = ${json(listener.url)}
env_key = "FIXTURE_KEY"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
      { mode: 0o600, flag: "wx" },
    );

    const cli = spawn(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        "--color",
        "never",
        "-m",
        model,
        "-c",
        'model_reasoning_effort="low"',
        "-c",
        'approval_policy="never"',
        "-c",
        'web_search="disabled"',
        "--disable",
        "shell_tool",
        "--disable",
        "unified_exec",
        "--disable",
        "memories",
        "--disable",
        "hooks",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        answerPath,
        dryQuestion,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: work,
          CODEX_HOME: work,
          FIXTURE_KEY: token,
        },
        cwd: work,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let stdout = "";
    const stop = () => {
      try {
        process.kill(-cli.pid, "SIGKILL");
      } catch {
        /* exited */
      }
    };
    cli.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 524288) stop();
    });
    const timer = setTimeout(stop, 55000);
    const exit = await new Promise((resolve, reject) => {
      cli.once("error", reject);
      cli.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(!stdout.includes(secretSentinel));
    assert.equal(exit, 0);
    assert.equal(listener.failures.length, 0);
    assert.ok(events.some(({ type }) => type === "turn.completed"));
    assert.deepEqual(
      JSON.parse(await fs.readFile(answerPath, "utf8")),
      JSON.parse(provider.expected()),
    );
    assert.ok(nativeTools);
    const summary = relay.summary();
    assert.equal(summary.forwarded, syntheticRequests);
    assert.ok(summary.excerptBytes > 0);

    const expectedTools = [
      ...syntheticFinds.map(() => "memory_find"),
      ...timelineOutcomes.map(() => "memory_timeline"),
      ...evidenceOutcomes.map(() => "memory_evidence"),
    ];
    const calls = events.filter(
      ({ type, item }) =>
        type === "item.completed" && item?.type === "mcp_tool_call",
    );
    assert.deepEqual(
      calls.map(({ item }) => item.tool),
      expectedTools,
    );
    assert.ok(
      calls.every(
        ({ item }) =>
          item.status === "completed" && item.result?.isError !== true,
      ),
    );
    const ledgerText = await fs.readFile(ledger, "utf8");
    assert.ok(!ledgerText.includes(secretSentinel));
    const rows = ledgerText.trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      rows.map((row) => row.tool),
      expectedTools,
    );
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["log", "proof", "tool"]);
      assert.match(row.proof, /^[0-9a-f]{64}$/);
      assert.equal(row.log.mcpDispatched, true);
    }
    const logs = rows.map((row) => row.log);
    assert.deepEqual(
      logs
        .filter((row) => row.tool === "memory_find")
        .map((row) => row.outcome),
      syntheticFinds.map((row) => row.outcome),
    );
    for (const [name, outcomes] of [
      ["memory_timeline", timelineOutcomes],
      ["memory_evidence", evidenceOutcomes],
    ]) {
      assert.deepEqual(
        logs.filter((row) => row.tool === name).map((row) => row.code),
        outcomes,
      );
    }
    return {
      lane: "synthetic-read-contract",
      nativeCli: true,
      nativeTools,
      requests: summary.forwarded,
      matchedMcpCalls: calls.length,
      backendSentinelAbsent: true,
      contentFreeLedger: true,
      recoveredAndCompleted: true,
      tools: logs,
      safety,
      externalModelCalls: 0,
    };
  } catch (error) {
    console.error(
      json({
        lane: "synthetic-read-contract",
        stage: relay?.summary().forwarded,
        failures: listener?.failures,
        assertion: error?.code === "ERR_ASSERTION",
      }),
    );
    throw new Error("Synthetic bounded read replay failed", { cause: error });
  } finally {
    listener?.close();
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === "--mcp") {
    const cfg = JSON.parse(sync.readFileSync(file, "utf8"));
    assert.equal(cfg.dry, true);
    const local = await openSyntheticBackend(cfg.repo, cfg.archive);
    const { startBoundedMcp } = require(
      path.join(cfg.repo, "lib/bounded-memory-relay.cjs"),
    );
    return startBoundedMcp(local, cfg);
  }
  assert.ok(!mode || mode === "--replay");
  console.log(json(await runReplay(path.resolve(file ?? "/memory"))));
}
if (require.main === module)
  main().catch(() => {
    console.error(
      "BLOCKED: the three-tool synthetic CLI replay did not complete.",
    );
    process.exitCode = 1;
  });
module.exports = { openSyntheticBackend, runReplay };
