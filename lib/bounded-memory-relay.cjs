"use strict";
const sync = require("node:fs");
const http = require("node:http");
const { createHash, createHmac } = require("node:crypto");
const { isDeepStrictEqual: same } = require("node:util");
const { startMcp } = require("./mcp.cjs");
const model = "gpt-6-luna",
  modelName = /^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/,
  names = ["memory_find", "memory_timeline", "memory_evidence"];
const limit = 4096,
  maxRequests = 16,
  maxMillis = 360000;
const keySet = (x, allowed, required = []) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).every((k) => allowed.includes(k)) &&
  required.every((k) => Object.hasOwn(x, k));
const bytes = (x) => Buffer.byteLength(x),
  digest = (x) => createHash("sha256").update(x).digest("hex"),
  json = (x) => JSON.stringify(x);
const safeId = (x) => typeof x === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(x);
function guard(ok, code) {
  if (!ok) throw Object.assign(Error(code), { safeCode: code });
}
function sharedContracts() {
  return {
    ...require("./generated/bounded-memory-find.cjs"),
    ...require("./generated/bounded-memory-read.cjs"),
  };
}
function toolCatalog() {
  const { createBoundedFind, createBoundedTimeline, createBoundedEvidence } =
    sharedContracts();
  const unused = () => {
    throw Error("catalog-only");
  };
  const specs = [
    createBoundedFind(unused, unused),
    createBoundedTimeline(unused, unused),
    createBoundedEvidence(unused, unused),
  ];
  return [
    {
      type: "namespace",
      name: "mcp__memory",
      description: "Read-only historical memory tools.",
      tools: specs.map(({ description, inputSchema }, i) => ({
        type: "function",
        name: names[i],
        description,
        parameters: inputSchema,
        strict: false,
      })),
    },
  ];
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const toolReceipt = (name, args, output, key) =>
  createHmac("sha256", key)
    .update(json(canonical([name, args, output])))
    .digest("hex");
const shapeOnly = (x) =>
  x &&
  ["message", "function_call", "function_call_output", "reasoning"].includes(
    x.type,
  )
    ? x.type
    : "unknown";
async function startBoundedMcp(
  local,
  { ledger, argumentKey, classify = () => [], allowedClues = [] },
) {
  const { createBoundedFind, createBoundedTimeline, createBoundedEvidence } =
    sharedContracts();
  const issuedTopics = new Set();
  let issuedCitations = new Map(),
    entries = [],
    emitted = 0;
  const record = (name, args, output, log) =>
    sync.appendFileSync(
      ledger,
      json({
        tool: name,
        proof: toolReceipt(name, args, output, argumentKey),
        log: { tool: name, ...log },
      }) + "\n",
      { mode: 0o600 },
    );
  const bindFind = (report) =>
    createBoundedFind(async ({ keyword }) => {
      const result = await local.find(keyword);
      return {
        topics: result.topics,
        searchMayHaveMore: result.coverage.searchMayHaveMore,
      };
    }, report);
  const findTool = {
    ...bindFind(() => {}),
    async run(raw) {
      let diagnostic;
      const output = await bindFind((result) => {
        diagnostic = result;
      }).run(raw);
      guard(diagnostic, "find-diagnostic-missing");
      for (const result of output.topics) issuedTopics.add(result.topic);
      record("memory_find", raw, output, diagnostic);
      return output;
    },
  };
  const sign = (name, tool) => ({
    ...tool,
    async run(raw) {
      const output = await tool.run(raw);
      const code = output.error?.code ?? null;
      const queryDispatched = ![
        "invalid-arguments",
        "topic-not-issued",
        "citation-not-issued",
      ].includes(code);
      record(name, raw, output, {
        mcpDispatched: true,
        queryDispatched,
        code,
        count:
          output.rows?.length ?? Number(typeof output.excerpt === "string"),
        excerptBytes:
          typeof output.excerpt === "string" ? bytes(output.excerpt) : 0,
      });
      return output;
    },
  });
  const timelineTool = sign(
    "memory_timeline",
    createBoundedTimeline(
      ({ topic }) => issuedTopics.has(topic),
      async ({ topic }) => {
        const t = await local.timeline(topic);
        guard(
          Number.isSafeInteger(t.scanned) &&
            t.scanned >= 0 &&
            Array.isArray(t.eligible) &&
            t.eligible.length <= 12,
          "timeline-shape",
        );
        const rows = t.eligible.map((e) => {
          guard(
            /^E(?:[1-9]|1[0-2])$/.test(e.ref) &&
              typeof e.row.time === "string" &&
              Number.isFinite(Date.parse(e.row.time)),
            "timeline-row-shape",
          );
          const clues = classify(e.quote.clean);
          guard(
            Array.isArray(clues) &&
              clues.every((label) => allowedClues.includes(label)),
            "timeline-clue-shape",
          );
          return {
            citation: { id: e.ref, revision: "V" + e.ref.slice(1) },
            at: e.row.time,
            clues,
          };
        });
        const next = new Map(
          rows.map(({ citation }) => [citation.id, citation.revision]),
        );
        guard(next.size === rows.length, "duplicate-timeline-alias");
        entries = t.eligible;
        issuedCitations = next;
        return {
          topic,
          coverage: {
            nativeRowsScanned: t.scanned,
            verifiedTechnicalUserInputs: rows.length,
          },
          rows,
        };
      },
    ),
  );
  const evidenceTool = sign(
    "memory_evidence",
    createBoundedEvidence(
      ({ id, revision }) => issuedCitations.get(id) === revision,
      async ({ id }) => {
        const r = await local.evidence(id, entries);
        guard(
          r.ref === id &&
            typeof r.at === "string" &&
            Number.isFinite(Date.parse(r.at)) &&
            typeof r.redacted === "boolean" &&
            typeof r.excerpt === "string" &&
            bytes(r.excerpt) <= 512,
          "excerpt-shape",
        );
        const excerptBytes = bytes(r.excerpt);
        if (emitted + excerptBytes > limit)
          return { error: { code: "excerpt-budget" } };
        emitted += excerptBytes;
        return {
          ref: r.ref,
          at: r.at,
          excerpt: r.excerpt,
          redacted: r.redacted,
        };
      },
    ),
  );
  await startMcp({}, { findTool, timelineTool, evidenceTool });
}
async function readLimited(body, cap) {
  const parts = [];
  let count = 0;
  for await (const chunk of body) {
    count += chunk.length;
    guard(count <= cap, "byte-boundary");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString("utf8");
}
function unpackOutput(x) {
  guard(
    Array.isArray(x) &&
      x.length === 2 &&
      x.every(
        (y) =>
          keySet(y, ["type", "text"], ["type", "text"]) &&
          y.type === "input_text" &&
          typeof y.text === "string",
      ),
    "tool-output-shape",
  );
  guard(
    x[0].text.length <= 180 && /Wall time:|Output|Chunk ID:/i.test(x[0].text),
    "tool-output-wrapper",
  );
  let value;
  try {
    value = JSON.parse(x[1].text.replace(/^Output:\s*/, ""));
  } catch {
    guard(false, "tool-output-unrecognized");
  }
  guard(
    value && typeof value === "object" && !Array.isArray(value),
    "tool-output-envelope",
  );
  return value;
}
function toolCall(x) {
  guard(
    x.type === "function_call" &&
      safeId(x.id) &&
      safeId(x.call_id) &&
      x.namespace === "mcp__memory" &&
      typeof x.arguments === "string",
    "provider-call-shape",
  );
  guard(names.includes(x.name), "unknown-tool");
  let args;
  try {
    args = JSON.parse(x.arguments);
  } catch {
    guard(false, "argument-parse");
  }
  guard(
    args && typeof args === "object" && !Array.isArray(args),
    "argument-envelope",
  );
  return {
    type: "function_call",
    id: x.id,
    call_id: x.call_id,
    namespace: "mcp__memory",
    name: x.name,
    arguments: json(canonical(args)),
  };
}
function createBoundedRelay(
  ledger,
  { argumentKey, prompt, runInstructions, finalSchema },
) {
  const tools = toolCatalog();
  const issued = new Map(),
    reasons = new Map(),
    answers = new Set(),
    fingerprints = new Set(),
    diagnostics = [],
    transmitted = new Map();
  const receiptByCall = new Map();
  const claimedReceipts = new Set();
  let raw = 0,
    encoded = 0,
    forwarded = 0;
  function body(rawBody) {
    guard(
      rawBody.model === model &&
        rawBody.reasoning?.effort === "low" &&
        rawBody.stream === true &&
        rawBody.store === false &&
        Array.isArray(rawBody.input),
      "native-request-shape",
    );
    guard(
      !rawBody.previous_response_id && !rawBody.conversation,
      "server-state-denied",
    );
    const input = [],
      calls = new Map(),
      used = new Set(),
      exports = new Map(),
      rows = sync
        .readFileSync(ledger, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    const newReceipts = new Map();
    const pendingReceipts = new Set();
    let promptCount = 0,
      rawBytes = 0,
      encodedBytes = 0,
      dev = 0,
      env = 0,
      droppedReasoning = 0;
    for (const x of rawBody.input) {
      if (x?.type === "message") {
        guard(
          keySet(
            x,
            ["type", "id", "role", "content", "phase"],
            ["type", "role", "content"],
          ) && Array.isArray(x.content),
          "message-shape",
        );
        if (x.role === "assistant") {
          guard(
            safeId(x.id) && answers.has(x.id),
            "unissued-assistant-message",
          );
          continue;
        }
        guard(
          x.content.every(
            (y) =>
              keySet(y, ["type", "text"], ["type", "text"]) &&
              y.type === "input_text" &&
              typeof y.text === "string",
          ),
          "message-content-shape",
        );
        if (x.role === "developer") {
          dev++;
          continue;
        }
        guard(x.role === "user" && x.content.length === 1, "unknown-user-item");
        const text = x.content[0].text;
        if (text === prompt) {
          promptCount++;
          input.push({ role: "user", content: prompt });
        } else {
          guard(
            /^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(
              text,
            ),
            "unknown-user-content",
          );
          env++;
        }
      } else if (x?.type === "reasoning") {
        guard(
          keySet(
            x,
            ["type", "id", "summary", "content", "encrypted_content", "status"],
            ["type", "id", "summary"],
          ) &&
            safeId(x.id) &&
            reasons.has(x.id),
          "unissued-reasoning",
        );
        const r = reasons.get(x.id);
        guard(
          (x.encrypted_content ?? null) === r.encrypted &&
            same(x.summary, r.summary),
          "reasoning-not-matched",
        );
        if (!r.beforeExcerpts) {
          droppedReasoning++;
          continue;
        }
        input.push({
          type: "reasoning",
          id: x.id,
          summary: [],
          ...(r.encrypted ? { encrypted_content: r.encrypted } : {}),
        });
      } else if (x?.type === "function_call") {
        guard(
          keySet(
            x,
            [
              "type",
              "status",
              "id",
              "name",
              "namespace",
              "arguments",
              "call_id",
            ],
            ["type", "id", "name", "namespace", "arguments", "call_id"],
          ),
          "function-call-keys",
        );
        const c = toolCall(x);
        guard(
          same(c, issued.get(c.call_id)) && !calls.has(c.call_id),
          "unissued-function-call",
        );
        calls.set(c.call_id, c);
        input.push(c);
      } else if (x?.type === "function_call_output") {
        guard(
          keySet(
            x,
            ["type", "id", "call_id", "output"],
            ["type", "call_id", "output"],
          ) &&
            calls.has(x.call_id) &&
            !used.has(x.call_id),
          "unpaired-tool-output",
        );
        used.add(x.call_id);
        const call = calls.get(x.call_id),
          out = unpackOutput(x.output);
        const args = JSON.parse(call.arguments),
          proof = toolReceipt(call.name, args, out, argumentKey);
        const matches = (row) => row?.tool === call.name && row.proof === proof;
        const index = receiptByCall.get(x.call_id);
        if (index === undefined) {
          const available = rows.findIndex(
            (row, i) =>
              !claimedReceipts.has(i) &&
              !pendingReceipts.has(i) &&
              matches(row),
          );
          guard(available !== -1, "tool-output-not-issued");
          newReceipts.set(x.call_id, available);
          pendingReceipts.add(available);
        } else {
          guard(matches(rows[index]), "tool-output-not-issued");
        }
        if (call.name === "memory_evidence" && !Object.hasOwn(out, "error")) {
          guard(
            keySet(
              out,
              ["ref", "at", "excerpt", "redacted"],
              ["ref", "at", "excerpt", "redacted"],
            ) &&
              typeof out.excerpt === "string" &&
              bytes(out.excerpt) <= 512 &&
              out.ref === args.id,
            "evidence-representation-denied",
          );
          rawBytes += bytes(out.excerpt);
          encodedBytes += bytes(json(json(out.excerpt)));
          exports.set(out.ref, out);
        }
        input.push({
          type: "function_call_output",
          call_id: x.call_id,
          output: json(out),
        });
      } else guard(false, "unknown-input-item");
    }
    guard(
      promptCount === 1 && calls.size === used.size,
      "unmatched-prompt-or-call",
    );
    guard(
      raw + rawBytes <= limit && encoded + encodedBytes <= limit,
      "aggregate-quote-budget",
    );
    guard(forwarded < maxRequests, "request-count-budget");
    guard(
      rawBody.tool_choice === undefined ||
        ["auto", "none", "required"].includes(rawBody.tool_choice),
      "tool-choice-denied",
    );
    const approved = {
      model,
      reasoning: { effort: "low" },
      instructions: runInstructions,
      input,
      store: false,
      stream: true,
      tools,
      tool_choice: rawBody.tool_choice ?? "auto",
      parallel_tool_calls: rawBody.parallel_tool_calls === true,
      include: ["reasoning.encrypted_content"],
      text: {
        format: {
          type: "json_schema",
          name: "historical_memory_answer",
          strict: true,
          schema: finalSchema,
        },
      },
    };
    const wire = json(approved),
      hash = digest(wire);
    guard(
      bytes(wire) <= 65536 && !fingerprints.has(hash),
      "oversize-or-duplicate-request",
    );
    fingerprints.add(hash);
    for (const [callId, index] of newReceipts) {
      receiptByCall.set(callId, index);
      claimedReceipts.add(index);
    }
    raw += rawBytes;
    encoded += encodedBytes;
    forwarded++;
    for (const [ref, x] of exports) transmitted.set(ref, x);
    diagnostics.push({
      inputTypes: rawBody.input.map(shapeOnly),
      developerDropped: dev,
      environmentDropped: env,
      postExcerptReasoningDropped: droppedReasoning,
      approvedTools: calls.size,
      approvedResults: used.size,
      wireBytes: bytes(wire),
      excerptBytes: rawBytes,
      conservativeExcerptBytes: encodedBytes,
    });
    return { wire, beforeExcerpts: raw === 0 };
  }
  function response(text, beforeExcerpts) {
    const chunks = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l !== "[DONE]");
    const events = chunks.map((l) => JSON.parse(l));
    const end = events.filter((e) => e.type === "response.completed");
    guard(
      end.length === 1 &&
        end[0].response?.status === "completed" &&
        modelName.test(end[0].response.model) &&
        Array.isArray(end[0].response.output),
      "provider-terminal-shape",
    );
    const actual = end[0].response,
      out = actual.output,
      types = out.map(shapeOnly),
      safe = [];
    guard(safeId(actual.id), "provider-response-id");
    const frame = { outputTypes: types, tools: [] };
    diagnostics.push(frame);
    for (const x of out) {
      if (x.type === "function_call") {
        frame.tools.push({
          name: names.includes(x.name) ? x.name : "denied",
          argumentKeys: (() => {
            try {
              return Object.keys(JSON.parse(x.arguments))
                .filter((k) =>
                  ["keyword", "limit", "topic", "id", "revision"].includes(k),
                )
                .sort();
            } catch {
              return [];
            }
          })(),
        });
        const c = toolCall(x);
        guard(!issued.has(c.call_id), "duplicate-provider-call");
        issued.set(c.call_id, c);
        safe.push({ ...c, status: "completed" });
      } else if (x.type === "reasoning") {
        guard(
          safeId(x.id) &&
            !reasons.has(x.id) &&
            Array.isArray(x.summary) &&
            (!x.encrypted_content ||
              (typeof x.encrypted_content === "string" &&
                x.encrypted_content.length <= 20000)),
          "provider-reasoning-shape",
        );
        reasons.set(x.id, {
          encrypted: x.encrypted_content ?? null,
          summary: [],
          beforeExcerpts,
        });
        safe.push({
          type: "reasoning",
          id: x.id,
          summary: [],
          ...(x.encrypted_content
            ? { encrypted_content: x.encrypted_content }
            : {}),
        });
      } else if (x.type === "message") {
        guard(
          safeId(x.id) && x.role === "assistant" && Array.isArray(x.content),
          "provider-message-shape",
        );
        answers.add(x.id);
        guard(
          x.content.every(
            (p) =>
              p.type === "output_text" &&
              typeof p.text === "string" &&
              bytes(p.text) <= 16000,
          ),
          "provider-text-shape",
        );
        safe.push({
          type: "message",
          id: x.id,
          role: "assistant",
          status: "completed",
          content: x.content.map((p) => ({
            type: "output_text",
            text: p.text,
            annotations: [],
          })),
        });
      } else guard(false, "unknown-provider-output");
    }
    return {
      id: actual.id,
      object: "response",
      created_at: Number.isSafeInteger(actual.created_at)
        ? actual.created_at
        : 0,
      status: "completed",
      model: actual.model,
      output: safe,
      usage: actual.usage,
    };
  }
  return {
    body,
    response,
    transmitted,
    summary: () => ({
      forwarded,
      excerptBytes: raw,
      conservativeExcerptBytes: encoded,
      diagnostics,
    }),
  };
}
function sse(r) {
  const events = [
    {
      type: "response.created",
      response: { ...r, status: "in_progress", output: [] },
    },
    ...r.output.map((item, output_index) => ({
      type: "response.output_item.done",
      output_index,
      item,
    })),
    { type: "response.completed", response: r },
  ];
  return events
    .map((e) => "event: " + e.type + "\ndata: " + json(e) + "\n\n")
    .join("");
}

async function listenBoundedRelay({ relay, send, token, observe = () => {} }) {
  const failures = [];
  const begin = Date.now();
  const server = http.createServer(async (req, res) => {
    try {
      guard(
        req.method === "POST" &&
          req.url === "/v1/responses" &&
          req.headers.authorization === "Bearer " + token,
        "unauthorized-local-request",
      );
      guard(Date.now() - begin < maxMillis, "run-deadline");
      let raw;
      try {
        raw = JSON.parse(await readLimited(req, 262144));
      } catch (e) {
        throw Object.assign(Error("native-request-json"), {
          safeCode: e.safeCode || "native-request-json",
        });
      }
      observe(raw);
      const { wire, beforeExcerpts } = relay.body(raw);
      const result = relay.response(await send(wire), beforeExcerpts);
      res
        .writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        })
        .end(sse(result));
    } catch (e) {
      failures.push({
        code: e?.safeCode ?? "protocol-or-local-failure",
        stage: relay.summary().forwarded,
        ...(Number.isInteger(e?.httpStatus)
          ? { httpStatus: e.httpStatus }
          : {}),
      });
      res
        .writeHead(400, { "content-type": "application/json" })
        .end('{"error":"bounded relay rejected"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: "http://127.0.0.1:" + server.address().port + "/v1",
    failures,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
module.exports = {
  model,
  names,
  limit,
  maxMillis,
  startBoundedMcp,
  createBoundedRelay,
  listenBoundedRelay,
  toolCatalog,
  toolReceipt,
  sse,
  readLimited,
};
