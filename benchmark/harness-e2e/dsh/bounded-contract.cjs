"use strict";
// Synthetic-only real DSH test. Run in an externally enforced loopback-only
// environment with no access to user profiles or credentials.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../../..");
const { openArchive } = require(path.join(repo, "lib/archive.cjs"));
const { operations } = require(path.join(repo, "lib/operations.cjs"));
const {
  startBoundedMcp,
  createBoundedRelay,
  listenBoundedRelay,
  sse,
} = require(path.join(repo, "lib/bounded-memory-relay.cjs"));
const key = "synthetic-test-key",
  token = "synthetic-test-token",
  prompt = "Use memory_find for synthetic.";
async function mcp(root) {
  const op = await operations({
    dir: path.join(root, "archive"),
    owner: "synthetic",
    project: "fixture",
    readOnly: true,
  });
  const local = {
    async find(keyword) {
      const r = await op.find({ keyword });
      return {
        topics: r.topics.length
          ? [{ topic: "T1", matchCount: r.topics[0].count }]
          : [],
        coverage: { searchMayHaveMore: false },
      };
    },
    async timeline() {
      const r = await op.timeline({ topic: "Synthetic" });
      return {
        scanned: r.rows.length,
        eligible: r.rows.map((row, i) => ({ ref: "E" + (i + 1), row })),
      };
    },
    async evidence(ref, entries) {
      const e = entries.find((x) => x.ref === ref),
        r = await op.evidence(e.row.citation);
      return { ref, at: e.row.time, excerpt: r.text, redacted: false };
    },
  };
  await startBoundedMcp(local, {
    ledger: path.join(root, "ledger"),
    argumentKey: key,
  });
}
async function main(cli) {
  assert.ok(path.isAbsolute(cli || ""), "Explicit DSH executable required");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-bounded-")),
    home = path.join(root, "profile");
  fs.mkdirSync(home);
  const ledger = path.join(root, "ledger");
  fs.writeFileSync(ledger, "", { mode: 0o600 });
  let listener;
  try {
    const archive = await openArchive({ dir: path.join(root, "archive") });
    await archive.importBatch({
      scope: { owner: "synthetic", project: "fixture" },
      source: { harness: "dsh", instance: "synthetic", session: "one" },
      checkpoint: { position: 1 },
      items: [
        {
          id: "one",
          kind: "message",
          role: "user",
          text: "Synthetic evidence.",
          time: "2026-01-01T00:00:00Z",
          metadata: { topic: "Synthetic" },
        },
      ],
    });
    archive.close?.();
    const context = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: ${JSON.stringify(fs.realpathSync(home))}.\n\nCurrent DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.\n\nApproval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set \`sandbox_permissions\`).`;
    const relay = createBoundedRelay(ledger, {
      argumentKey: key,
      prompt,
      runInstructions: "Use memory tools.",
      finalSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      dialect: "dsh",
      dshRuntimeContext: context,
    });
    const calls = [
      ["memory_find", { keyword: "synthetic" }],
      ["memory_timeline", { topic: "T1" }],
      ["memory_evidence", { id: "E1", revision: "V1" }],
    ];
    let count = 0;
    listener = await listenBoundedRelay({
      relay,
      token,
      async send(wire) {
        const request = JSON.parse(wire);
        assert.ok(
          request.tools.every((t) => t.name.startsWith("mcp__memory__")),
        );
        const i = count++;
        let answer;
        if (i === calls.length) {
          const evidence = request.input.find(
            (item) =>
              item.type === "function_call_output" && item.call_id === "call_2",
          );
          const value = JSON.parse(evidence.output);
          assert.equal(value.ref, "E1");
          assert.equal(value.excerpt, "Synthetic evidence.");
          answer = value.excerpt;
        }
        const item =
          i < calls.length
            ? {
                type: "function_call",
                id: "fc_" + i,
                call_id: "call_" + i,
                name: "mcp__memory__" + calls[i][0],
                arguments: JSON.stringify(calls[i][1]),
                status: "completed",
              }
            : {
                type: "message",
                id: "msg_final",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({ answer }),
                    annotations: [],
                  },
                ],
              };
        return sse({
          id: "resp_" + i,
          model: "gpt-6-luna",
          status: "completed",
          output: [item],
        });
      },
    });
    let patch = fs
      .readFileSync(path.join(__dirname, "provider.patch.yml"), "utf8")
      .replace("http://172.28.88.2:8080/v1", listener.url);
    patch += `\n- insert:\n    - id: mcp-synthetic-memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: memory\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(__filename)}, '--mcp', ${JSON.stringify(root)}]\n        failOnStartupError: true\n        reconnect:\n          enabled: false\n`;
    const patchFile = path.join(root, "patch.yml");
    fs.writeFileSync(patchFile, patch);
    const env = {
      PATH: process.env.PATH,
      DSH_HOME: home,
      DSH_AGENTS_HOME: path.join(root, "agents"),
      DSH_TELEMETRY_MODE: "DISABLED",
      OPENAI_API_KEY: token,
    };
    const version = spawnSync(cli, ["--version"], {
      cwd: home,
      env,
      encoding: "utf8",
    });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), "0.2.2-rc.1");
    const child = spawn(
      cli,
      [
        "--profile",
        "headless",
        "--patch",
        patchFile,
        "--json",
        "--permission-mode",
        "read-only",
        "--approval-policy",
        "never",
        prompt,
      ],
      { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
    const code = await new Promise((resolve) => {
      child.on("error", () => resolve(null));
      child.on("close", resolve);
    });
    clearTimeout(timer);
    assert.equal(code, 0);
    assert.equal(count, 4);
    assert.deepEqual(listener.failures, []);
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const final = events.find(
      (event) => event.type === "final" && event.reason?.kind === "completed",
    );
    assert.equal(JSON.parse(final.text).answer, "Synthetic evidence.");
    assert.equal(relay.summary().excerptBytes, 19);
    console.log(
      JSON.stringify({
        synthetic: true,
        harness: "dsh",
        requests: count,
        completed: true,
        provider: "loopback-fake",
      }),
    );
  } finally {
    listener?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[2] === "--mcp")
  mcp(process.argv[3]).catch(() => {
    process.exitCode = 1;
  });
else
  main(process.argv[2]).catch(() => {
    console.error("Synthetic DSH bounded replay failed");
    process.exitCode = 1;
  });
