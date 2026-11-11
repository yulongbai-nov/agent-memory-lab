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
    const collector = require(join(installed, "lib", "collector.cjs"));
    assert.equal(typeof collector.collectChanged, "function");
    const source = join(work, "collector-source");
    const collectorArchive = join(work, "collector-archive");
    await fs.mkdir(source);
    await fs.mkdir(collectorArchive, { mode: 0o700 });
    const session = join(source, "fixture.jsonl");
    await fs.writeFile(session, "synthetic first");
    const operation = {
      scope: { owner: "fixture", project: "fixture" },
      archive: { dir: collectorArchive },
    };
    const input = { root: source, source: "codex", instance: "fixture" };
    const ingest = async () => ({ itemsImported: 1 });
    assert.equal(
      (await collector.collectChanged(operation, input, ingest)).baseline,
      true,
    );
    await fs.appendFile(session, " synthetic second");
    assert.equal(
      (await collector.collectChanged(operation, input, ingest)).itemsImported,
      1,
    );

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
