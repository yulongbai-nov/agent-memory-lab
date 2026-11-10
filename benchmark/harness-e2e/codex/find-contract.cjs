"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const {
  functionToolCatalog,
  lastToolOutput,
  sendResponse,
} = require("./recall.cjs");

function runMcp(repo, diagnosticPath) {
  const { appendFileSync } = require("node:fs");
  const { startMcp } = require(join(repo, "lib/mcp.cjs"));
  const { createBoundedFind } = require(
    join(repo, "lib/generated/bounded-memory-find.cjs"),
  );
  const findTool = createBoundedFind(
    ({ keyword }) => ({
      topics: keyword ? [] : [{ topic: "T1", matchCount: 1 }],
      searchMayHaveMore: false,
    }),
    (metadata) =>
      appendFileSync(diagnosticPath, JSON.stringify(metadata) + "\n", {
        mode: 0o600,
      }),
  );
  return startMcp({}, { findTool });
}

function findFunction(tools) {
  const namespace = tools?.find(
    (tool) => tool.type === "namespace" && tool.name === "mcp__memory",
  );
  const nested = namespace?.tools?.find(
    (tool) => tool.type === "function" && tool.name === "memory_find",
  );
  const fn =
    nested ??
    tools?.find(
      (tool) => tool.type === "function" && tool.name.endsWith("__memory_find"),
    );
  assert.ok(fn, "find function advertised");
  return { fn, namespace: nested ? namespace.name : undefined };
}

function makeVectors(schema, published, ajv) {
  const validateNative = ajv.compile(schema);
  const validatePublished = ajv.compile(published);
  const acceptsNull = (property) => {
    const validate = ajv.compile({ ...schema, required: [property] });
    return validate({ [property]: null });
  };
  const vectors = [];
  const valid = (label, args, limit = 5, empty = false) => {
    assert.ok(validateNative(args), label + " must satisfy the native schema");
    assert.ok(validatePublished(args), label + " must satisfy the MCP schema");
    vectors.push({ label, args, limit, empty });
  };
  const { keyword, limit } = schema.properties;
  const maxLength = keyword.maxLength ?? published.properties.keyword.maxLength;
  const maximum = limit.maximum ?? published.properties.limit.maximum;
  const minimum = limit.minimum ?? published.properties.limit.minimum;
  valid("omitted", {});
  valid("five", { limit: 5 });
  if (acceptsNull("limit")) valid("nullable-limit", { limit: null });
  if (acceptsNull("keyword")) valid("nullable-keyword", { keyword: null });
  valid("minimum", { limit: minimum }, minimum);
  valid("larger-limit", { limit: Math.min(maximum, 20) });
  valid("maximum", { limit: maximum });
  for (const [label, keywordValue] of [
    ["empty-string", ""],
    ["whitespace", " \t "],
    ["chinese", "合成查询"],
    ["spaces-punctuation", " 两 段 / demo?! "],
    ["unicode-boundary", "🧪".repeat(maxLength)],
  ]) {
    valid(label, { keyword: keywordValue }, 5, Boolean(keywordValue.trim()));
  }

  for (const [error, args] of [
    ["keyword-max-length", { keyword: "🧪".repeat(maxLength + 1), limit: 5 }],
    ["limit-minimum", { limit: minimum - 1 }],
    ["limit-maximum", { limit: maximum + 1 }],
    ["limit-type", { limit: 1.5 }],
    ["keyword-type", { keyword: 42 }],
    ["additional-property", { extra: "synthetic" }],
  ]) {
    assert.equal(validatePublished(args), false, error);
    vectors.push({ label: error, args, error });
  }
  // Submit null as a compatibility check even when this CLI omits null from the schema.
  if (!acceptsNull("keyword") || !acceptsNull("limit")) {
    vectors.push({
      label: "nullable-compatibility",
      args: { keyword: null, limit: null },
      limit: 5,
    });
  }
  valid("recovery", {});
  return vectors;
}

async function runReplay(repo) {
  const Ajv = require(join(repo, "node_modules/ajv"));
  const { createBoundedFind } = require(
    join(repo, "lib/generated/bounded-memory-find.cjs"),
  );
  const published = createBoundedFind(
    () => {
      throw new Error("unused");
    },
    () => {},
  ).inputSchema;
  const ajv = new Ajv();
  const work = await fs.mkdtemp(join(tmpdir(), "memlab-find-"));
  const diagnosticPath = join(work, "diagnostics.jsonl");
  const final = "Synthetic find contract replay completed.";
  let stage = 0;
  let vectors;
  let advertisement;
  let failed;
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/responses");
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 262144) throw new Error("fixture request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!vectors) {
        const { fn, namespace } = findFunction(body.tools);
        advertisement = {
          name: fn.name,
          namespace,
          parameters: fn.parameters,
          description: fn.description,
          strict: fn.strict,
        };
        vectors = makeVectors(fn.parameters, published, ajv);
      }
      if (stage > 0) {
        const prior = vectors[stage - 1];
        const result = lastToolOutput(body, "find_call_" + (stage - 1));
        assert.deepEqual(result.error?.code, prior.error, prior.label);
        assert.deepEqual(
          result.topics,
          prior.error || prior.empty ? [] : [{ topic: "T1", matchCount: 1 }],
          prior.label,
        );
        assert.equal(result.coverage.effectiveLimit, prior.limit, prior.label);
      }
      if (stage === vectors.length) {
        sendResponse(res, stage++, {
          id: "find_final",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: final, annotations: [] }],
        });
        return;
      }
      sendResponse(res, stage, {
        id: "find_fc_" + stage,
        call_id: "find_call_" + stage,
        type: "function_call",
        name: advertisement.name,
        namespace: advertisement.namespace,
        arguments: JSON.stringify(vectors[stage].args),
        status: "completed",
      });
      stage++;
    } catch {
      failed = true;
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":"synthetic find replay rejected"}');
    }
  });

  try {
    const catalog = await functionToolCatalog(work);
    await new Promise((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", done);
    });
    await fs.writeFile(
      join(work, "config.toml"),
      `
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(catalog)}
[mcp_servers.memory]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([__filename, "--mcp", repo, diagnosticPath])}
required = true
enabled_tools = ["memory_find"]
default_tools_approval_mode = "approve"
[model_providers.fixture]
name = "fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
env_key = "FIXTURE_KEY"
wire_api = "responses"
supports_websockets = false
`,
      { mode: 0o600 },
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
        "gpt-6-luna",
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
        "Run the synthetic find fixture.",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: work,
          CODEX_HOME: work,
          FIXTURE_KEY: "synthetic-only",
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
    const timer = setTimeout(stop, 55000);
    cli.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 524288) stop();
    });
    const code = await new Promise((done, fail) => {
      cli.once("error", fail);
      cli.once("close", done);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 0);
    assert.equal(failed, undefined);
    assert.equal(stage, vectors.length + 1);
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const calls = events.filter(
      ({ type, item }) =>
        type === "item.completed" && item?.type === "mcp_tool_call",
    );
    assert.equal(calls.length, vectors.length);
    assert.ok(
      calls.every(
        ({ item }) =>
          item.tool === "memory_find" && item.status === "completed",
      ),
    );
    assert.ok(calls.every(({ item }) => item.result?.isError !== true));
    assert.ok(events.some(({ type }) => type === "turn.completed"));
    assert.ok(
      events.some(
        ({ item }) => item?.type === "agent_message" && item.text === final,
      ),
    );

    const lines = (await fs.readFile(diagnosticPath, "utf8"))
      .trim()
      .split("\n");
    const diagnostics = lines.map((line) => JSON.parse(line));
    assert.equal(diagnostics.length, vectors.length);
    const result = vectors.map(({ label, args, error, limit }, index) => {
      const diagnostic = diagnostics[index];
      const keyword = args.keyword;
      const type = (value) =>
        value === undefined
          ? "missing"
          : value === null
            ? "null"
            : typeof value;
      assert.deepEqual(
        diagnostic,
        {
          keyword: {
            type: type(keyword),
            ...(typeof keyword === "string" && {
              empty: keyword.trim() === "",
              characters: [...keyword].length,
              utf8Bytes: Buffer.byteLength(keyword),
            }),
          },
          limit: {
            type: type(args.limit),
            ...(typeof args.limit === "number" && { value: args.limit }),
          },
          constraint: error ?? null,
          mcpDispatched: true,
          queryDispatched: !error,
          ...(limit !== undefined && { effectiveLimit: limit }),
        },
        label,
      );
      return { label, ...diagnostic };
    });
    console.log(
      JSON.stringify({
        lane: "synthetic-find-contract",
        nativeCli: true,
        advertisement,
        mcpSchema: published,
        vectors: result,
        externalModelCalls: 0,
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        lane: "synthetic-find-contract",
        stage,
        failed,
        advertisement,
      }),
    );
    throw new Error("Synthetic find contract gates failed");
  } finally {
    server.close();
    await fs.rm(work, { recursive: true, force: true });
  }
}

const [mode, repoPath, diagnostics] = process.argv.slice(2);
const repo = resolve(repoPath ?? "/memory");
const operation =
  mode === "--mcp" ? runMcp(repo, diagnostics) : runReplay(repo);
operation.catch(() => {
  console.error("BLOCKED: bounded memory find contract did not complete.");
  process.exitCode = 1;
});
