"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { basename, join } = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 60000 });
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "memory-lab-package-"));
  let client;
  try {
    const output = run("npm", ["pack", "--json", "--pack-destination", work]);
    const filename = JSON.parse(output)[0].filename;
    assert.equal(filename, basename(filename));
    const prefix = join(work, "install");
    run("npm", [
      "install",
      "--prefix",
      prefix,
      "--prefer-offline",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(work, filename),
    ]);
    const installed = join(prefix, "node_modules", "agent-memory-lab");
    assert.equal(existsSync(join(prefix, "node_modules", "typescript")), false);
    const source = join(work, "collector-source");
    const collectorArchive = join(work, "collector-archive");
    const manifest = join(work, "collector-manifest.json");
    await fs.mkdir(source);
    await fs.mkdir(collectorArchive, { mode: 0o700 });
    const session = join(source, "fixture.jsonl");
    const message = (text) =>
      JSON.stringify({
        type: "message",
        payload: { role: "user", content: text },
      }) + "\n";
    await fs.writeFile(session, message("synthetic first"));
    await fs.writeFile(
      manifest,
      JSON.stringify([
        {
          root: source,
          source: "codex",
          instance: "fixture",
          incremental: true,
          "max-sessions": "3",
          "max-records": "40",
        },
      ]),
    );
    const watch = () =>
      JSON.parse(
        run(process.execPath, [
          join(installed, "bin", "memory.cjs"),
          "watch",
          "--manifest",
          manifest,
          "--dir",
          collectorArchive,
          "--owner",
          "fixture",
          "--project",
          "fixture",
          "--runs",
          "1",
        ]),
      );
    const baseline = watch();
    assert.equal(baseline.collector.baselines, 1);
    assert.equal(baseline.collector.sessionsAttempted, 0);
    await fs.appendFile(session, message("synthetic second"));
    const incremental = watch();
    assert.equal(incremental.collector.sessionsAttempted, 1);
    assert.ok(incremental.collector.itemsImported >= 1);
    const replay = watch();
    assert.equal(replay.collector.sessionsAttempted, 0);
    assert.equal(replay.collector.itemsImported, 0);

    const helper = await fs.lstat(join(installed, "lib", "nocache-hash.py"));
    assert.ok(helper.isFile() && !helper.isSymbolicLink());
    const noCache = require(join(installed, "lib", "nocache-hash.cjs"));
    assert.equal(typeof noCache.hashNoCache, "function");
    assert.equal(typeof noCache.validateHelperResult, "function");
    const validation = require(
      join(installed, "lib", "semantic-validation.cjs"),
    );
    const queue = require(join(installed, "lib", "semantic-queue.cjs"));
    const snapshot = require(
      join(installed, "lib", "adapters", "chatgpt-snapshot.cjs"),
    );
    const ontology = require(join(installed, "lib", "ontology-projection.cjs"));
    assert.equal(typeof snapshot.readChatgptSnapshot, "function");
    assert.equal(typeof ontology.rebuildProjection, "function");
    const reference = { source: "fixture", item: "item", version: "revision" };
    const candidates = validation.validateCandidates(
      {
        candidates: [
          {
            kind: "decision",
            claim: "Use Tuesday.",
            evidence: [{ ...reference, quote: "Use Tuesday." }],
          },
        ],
      },
      [{ ...reference, text: "Use Tuesday. Then verify." }],
    );
    assert.equal(candidates[0].evidence[0].version, reference.version);
    assert.deepEqual(
      queue.semanticQueueFromSummaries([
        { versionId: reference.version, pendingReview: true, previewBytes: 12 },
      ]).pending,
      [reference.version],
    );
    const archive = join(work, "archive");
    run(process.execPath, [join(installed, "bin", "seed-demo.cjs"), archive]);
    const preview = JSON.parse(
      run(process.execPath, [
        join(installed, "bin", "memory.cjs"),
        "find",
        "--keyword",
        "release",
        "--preview",
        "--dir",
        archive,
        "--project",
        "demo",
      ]),
    );
    assert.ok(
      preview.topics.some(
        (row) =>
          row.preview?.label === "归档消息" &&
          row.preview.text.toLowerCase().includes("release"),
      ),
    );
    assert.ok(
      preview.topics.every(
        (row) => !row.preview || Buffer.byteLength(row.preview.text) <= 240,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(installed, "bin", "memory.cjs"),
        "mcp",
        "--dir",
        archive,
        "--project",
        "demo",
      ],
      stderr: "ignore",
    });
    client = new Client({ name: "packed-smoke", version: "0.1.0" });
    await client.connect(transport, { timeout: 5000 });
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "memory_find"));
    const result = await client.callTool({
      name: "memory_find",
      arguments: { keyword: "Release", limit: 5 },
    });
    assert.equal(result.isError ?? false, false);
    const payload = result.content.find((item) => item.type === "text");
    assert.ok(
      JSON.parse(payload.text).topics.some(
        (row) => row.topic === "Release checklist",
      ),
    );
    assert.ok(!payload.text.includes("previewCitations"));
    console.log(
      "Packed production dependencies passed both semantic modules and MCP find.",
    );
  } finally {
    await client?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
