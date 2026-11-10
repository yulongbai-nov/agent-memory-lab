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
function canonicalTimestamp(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  guard(Number.isFinite(milliseconds), "timestamp-shape");
  return new Date(milliseconds).toISOString();
}
async function startBoundedMcp(local, { ledger, argumentKey }) {
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
          guard(/^E(?:[1-9]|1[0-2])$/.test(e.ref), "timeline-row-shape");
          return {
            citation: { id: e.ref, revision: "V" + e.ref.slice(1) },
            at: canonicalTimestamp(e.row.time),
            clues: [],
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
            typeof r.redacted === "boolean" &&
            typeof r.excerpt === "string" &&
            bytes(r.excerpt) <= 512,
          "excerpt-shape",
        );
        const at = canonicalTimestamp(r.at);
        const excerptBytes = bytes(r.excerpt);
        if (emitted + excerptBytes > limit)
          return { error: { code: "excerpt-budget" } };
        emitted += excerptBytes;
        return {
          ref: r.ref,
          at,
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
    keySet(
      x,
      ["type", "id", "call_id", "namespace", "name", "arguments", "status"],
      ["type", "id", "call_id", "namespace", "name", "arguments"],
    ) &&
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
  return x;
}
function sameIssuedItem(received, issued) {
  if (!issued) return false;
  // Native Responses serialization can omit status and empty reasoning content,
  // or fill absent reasoning fields with null. Replay the approved provider
  // object after verifying this limited projection.
  const inputItem = { ...received };
  if (!Object.hasOwn(inputItem, "status") && Object.hasOwn(issued, "status")) {
    inputItem.status = issued.status;
  }
  if (issued.type === "reasoning") {
    if (
      !Object.hasOwn(inputItem, "content") &&
      Array.isArray(issued.content) &&
      issued.content.length === 0
    ) {
      inputItem.content = [];
    }
    for (const key of ["content", "encrypted_content"]) {
      if (inputItem[key] === null && !Object.hasOwn(issued, key))
        delete inputItem[key];
    }
  }
  return same(inputItem, issued);
}
function validTextParts(parts, type) {
  return (
    Array.isArray(parts) &&
    parts.every(
      (part) =>
        keySet(part, ["type", "text"], ["type", "text"]) &&
        part.type === type &&
        typeof part.text === "string" &&
        bytes(part.text) <= 16000,
    )
  );
}
function createBoundedRelay(
  ledger,
  { argumentKey, prompt, runInstructions, finalSchema },
) {
  const tools = toolCatalog();
  const issued = new Map(),
    providerItems = new Map(),
    fingerprints = new Set(),
    diagnostics = [],
    transmitted = new Map();
  const receiptByCall = new Map();
  const claimedReceipts = new Set();
  let history = [{ role: "user", content: prompt }];
  let pending = [];
  let requestSettings;
  let awaitingProvider = false;
  let raw = 0,
    encoded = 0,
    echoes = 0,
    forwarded = 0;
  function body(rawBody) {
    guard(!awaitingProvider, "provider-response-pending");
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
      env = 0;
    for (const x of rawBody.input) {
      if (x?.type === "message") {
        guard(
          keySet(
            x,
            ["type", "id", "role", "content", "phase", "status"],
            ["type", "role", "content"],
          ) && Array.isArray(x.content),
          "message-shape",
        );
        if (x.role === "assistant") {
          const item = providerItems.get(x.id);
          guard(
            item?.role === "assistant" && sameIssuedItem(x, item),
            "assistant-not-matched",
          );
          input.push(item);
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
        const item = providerItems.get(x.id);
        const matched = item?.type === "reasoning" && sameIssuedItem(x, item);
        if (!matched) {
          const fields = [
            "type",
            "id",
            "summary",
            "content",
            "encrypted_content",
            "status",
          ];
          diagnostics.push({
            rejection: "reasoning-not-matched",
            issuedReasoningFound: item?.type === "reasoning",
            differingKnownFields: fields.filter(
              (field) => !same(x[field], item?.[field]),
            ),
            extraFieldCount: Object.keys(x).filter(
              (field) => !fields.includes(field),
            ).length,
            nativeContentPresent: Object.hasOwn(x, "content"),
            nativeContentItems: Array.isArray(x.content)
              ? x.content.length
              : null,
            issuedContentItems: Array.isArray(item?.content)
              ? item.content.length
              : null,
          });
        }
        guard(matched, "reasoning-not-matched");
        input.push(item);
      } else if (x?.type === "function_call") {
        const c = toolCall(x);
        const item = issued.get(c.call_id);
        guard(
          sameIssuedItem(c, item) && !calls.has(c.call_id),
          "unissued-function-call",
        );
        calls.set(c.call_id, item);
        input.push(item);
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
    const expectedPrefix = [...history, ...pending];
    const expectedCalls = pending.filter(
      (item) => item.type === "function_call",
    );
    const appendedResults = input.slice(expectedPrefix.length);
    guard(
      same(input.slice(0, expectedPrefix.length), expectedPrefix) &&
        appendedResults.length === expectedCalls.length &&
        appendedResults.every(
          (item, index) =>
            item.type === "function_call_output" &&
            item.call_id === expectedCalls[index].call_id,
        ) &&
        (forwarded === 0 || expectedCalls.length > 0),
      "history-prefix-or-order",
    );
    // Once a quote is sent, conservatively charge every replayed plaintext
    // argument, even from a rejected call or from earlier in the same request.
    // Opaque state is counted by the total wire-size limit below.
    const opaqueReasoningBytes = input.reduce(
      (total, item) =>
        total +
        (item.type === "reasoning" && typeof item.encrypted_content === "string"
          ? bytes(json(item.encrypted_content))
          : 0),
      0,
    );
    let echoBytes = 0;
    if (raw + rawBytes > 0) {
      for (const item of input) {
        if (item.type === "function_call") {
          echoBytes +=
            bytes(json(item.arguments)) +
            bytes(json(item.id)) +
            bytes(json(item.call_id));
        } else if (item.type === "function_call_output") {
          echoBytes += bytes(json(item.call_id));
        } else if (item.role === "assistant") {
          echoBytes += bytes(json(item.content)) + bytes(json(item.id));
        } else if (item.type === "reasoning") {
          echoBytes += bytes(json(item.id));
          if (item.summary.length) echoBytes += bytes(json(item.summary));
          if (item.content?.length) echoBytes += bytes(json(item.content));
        }
      }
    }
    const budgetBytes = encodedBytes + echoBytes;
    const priorBudgetBytes = encoded + echoes;
    if (priorBudgetBytes + budgetBytes > limit) {
      diagnostics.push({
        rejection: "aggregate-quote-budget",
        excerptBytes: rawBytes,
        conservativeExcerptBytes: encodedBytes,
        echoBytes,
        budgetBytes,
        priorBudgetBytes,
      });
      guard(false, "aggregate-quote-budget");
    }
    guard(forwarded < maxRequests, "request-count-budget");
    guard(
      rawBody.tool_choice === undefined ||
        ["auto", "none", "required"].includes(rawBody.tool_choice),
      "tool-choice-denied",
    );
    const settings = {
      tool_choice: rawBody.tool_choice ?? "auto",
      parallel_tool_calls: rawBody.parallel_tool_calls === true,
    };
    guard(
      !requestSettings || same(requestSettings, settings),
      "request-prefix-settings-changed",
    );
    const approved = {
      model,
      reasoning: { effort: "low" },
      instructions: runInstructions,
      input,
      store: false,
      stream: true,
      tools,
      ...settings,
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
    const wire = json(approved);
    const wireBytes = bytes(wire);
    if (wireBytes > 65536) {
      diagnostics.push({
        rejection: "wire-byte-budget",
        wireBytes,
        opaqueReasoningBytes,
      });
      guard(false, "wire-byte-budget");
    }
    const hash = digest(wire);
    guard(!fingerprints.has(hash), "duplicate-request");
    fingerprints.add(hash);
    history = input;
    requestSettings = settings;
    awaitingProvider = true;
    for (const [callId, index] of newReceipts) {
      receiptByCall.set(callId, index);
      claimedReceipts.add(index);
    }
    raw += rawBytes;
    encoded += encodedBytes;
    echoes += echoBytes;
    forwarded++;
    for (const [ref, x] of exports) transmitted.set(ref, x);
    diagnostics.push({
      inputTypes: rawBody.input.map(shapeOnly),
      developerDropped: dev,
      environmentDropped: env,
      opaqueReasoningBytes,
      approvedTools: calls.size,
      approvedResults: used.size,
      wireBytes,
      excerptBytes: rawBytes,
      conservativeExcerptBytes: encodedBytes,
      echoBytes,
      budgetBytes,
    });
    return { wire };
  }
  function response(text) {
    guard(awaitingProvider, "unsolicited-provider-response");
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
      types = out.map(shapeOnly);
    guard(safeId(actual.id), "provider-response-id");
    const frame = { outputTypes: types, tools: [] };
    const responseIds = new Set();
    const responseCalls = new Set();
    for (const x of out) {
      guard(
        safeId(x?.id) && !responseIds.has(x.id) && !providerItems.has(x.id),
        "duplicate-provider-item",
      );
      responseIds.add(x.id);
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
        guard(
          !issued.has(c.call_id) && !responseCalls.has(c.call_id),
          "duplicate-provider-call",
        );
        responseCalls.add(c.call_id);
      } else if (x.type === "reasoning") {
        guard(
          keySet(
            x,
            ["type", "id", "summary", "content", "encrypted_content", "status"],
            ["type", "id", "summary"],
          ) &&
            validTextParts(x.summary, "summary_text") &&
            (x.content == null ||
              validTextParts(x.content, "reasoning_text")) &&
            (x.encrypted_content == null ||
              (typeof x.encrypted_content === "string" &&
                bytes(x.encrypted_content) <= 20000)),
          "provider-reasoning-shape",
        );
      } else if (x.type === "message") {
        guard(
          keySet(
            x,
            ["type", "id", "role", "content", "phase", "status"],
            ["type", "id", "role", "content"],
          ) &&
            x.role === "assistant" &&
            (x.phase == null ||
              ["commentary", "final_answer"].includes(x.phase)) &&
            Array.isArray(x.content) &&
            x.content.every(
              (part) =>
                keySet(
                  part,
                  ["type", "text", "annotations", "logprobs"],
                  ["type", "text", "annotations"],
                ) &&
                part.type === "output_text" &&
                typeof part.text === "string" &&
                bytes(part.text) <= 16000 &&
                Array.isArray(part.annotations) &&
                part.annotations.length === 0 &&
                (part.logprobs == null ||
                  (Array.isArray(part.logprobs) && part.logprobs.length === 0)),
            ),
          "provider-message-shape",
        );
      } else guard(false, "unknown-provider-output");
      guard(
        x.status == null || x.status === "completed",
        "provider-item-status",
      );
    }
    for (const x of out) {
      providerItems.set(x.id, x);
      if (x.type === "function_call") issued.set(x.call_id, x);
    }
    pending = out;
    awaitingProvider = false;
    diagnostics.push(frame);
    return {
      id: actual.id,
      object: "response",
      created_at: Number.isSafeInteger(actual.created_at)
        ? actual.created_at
        : 0,
      status: "completed",
      model: actual.model,
      output: out,
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
      echoBytes: echoes,
      budgetBytes: encoded + echoes,
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
      const { wire } = relay.body(raw);
      const result = relay.response(await send(wire));
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
