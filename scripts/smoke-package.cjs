"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
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

async function packedDraftSmoke(installed, dir) {
  const { openArchive } = require(join(installed, "lib", "archive.cjs"));
  const { migrateJsonToSqlite } = require(
    join(installed, "lib", "storage-sqlite.cjs"),
  );
  const { originalCapture } = require(join(installed, "lib", "originals.cjs"));
  const { projectionChoices } = require(
    join(installed, "lib", "local-derive-selection.cjs"),
  );
  const { verifiedProjections } = require(
    join(installed, "lib", "local-derive-projection.cjs"),
  );
  const scope = { owner: "fixture", project: "fixture" };
  const source = { harness: "dsh", instance: "packed", session: "draft" };
  const id = "packed-draft-item";
  const quote = "下一步检查公开合成例。";
  await migrateJsonToSqlite({ dir });
  const archive = await openArchive({ dir });
  let row;
  try {
    const original = await originalCapture(dir)({
      coordinate: 1,
      bytes: Buffer.from(
        JSON.stringify({
          type: "user/message",
          data: { role: "user", text: quote },
        }) + "\n",
      ),
    });
    await archive.importBatch({
      scope,
      source,
      checkpoint: { position: 1 },
      items: [
        {
          id,
          kind: "message",
          role: "user",
          text: quote,
          metadata: { original },
        },
      ],
    });
    row = await archive.getItem({ ...scope, source, id });
  } finally {
    archive.close?.();
  }
  assert.ok(row);
  const [choice] = await verifiedProjections(
    dir,
    row,
    projectionChoices(quote),
  );
  assert.equal(choice.text, quote);
  const exact = {
    source: "dsh/packed/draft",
    item: id,
    version: row.versionId,
  };
  const scopeKey = createHash("sha256")
    .update(JSON.stringify([scope.owner, scope.project]))
    .digest("hex");
  const folder = join(dir, "local-derive");
  await fs.mkdir(folder, { mode: 0o700 });
  const latest = join(folder, `latest-${scopeKey}.json`);
  const data = JSON.stringify({
    runtime: "macos-offline-private",
    scopeKey,
    generatedAt: "2026-01-01T00:00:00.000Z",
    draftFile: `draft-${"a".repeat(64)}.txt`,
    inputProjections: [{ ...exact, ...choice.projection }],
    candidates: [
      {
        kind: "todo",
        status: "待核实",
        claim: quote,
        evidence: [{ ...exact, quote, originalSpan: choice.projection }],
      },
    ],
  });
  await fs.writeFile(latest, data, { mode: 0o600, flag: "wx" });
  const cli = (command, ...args) =>
    JSON.parse(
      run(process.execPath, [
        join(installed, "bin", "memory.cjs"),
        command,
        "--dir",
        dir,
        "--owner",
        scope.owner,
        "--project",
        scope.project,
        ...args,
      ]),
    );
  const list = cli("draft-list");
  assert.equal(list.status, "ready");
  assert.equal(list.candidates.length, 1);
  assert.ok(!Object.hasOwn(list.candidates[0], "claim"));
  const detail = cli("draft-show", "--id", list.candidates[0].id);
  assert.equal(detail.candidate.status, "待核实");
  assert.equal(detail.candidate.evidence[0].quoteStatus, "verified-original");
  assert.equal(detail.candidate.evidence[0].quote, quote);
  assert.equal(await fs.readFile(latest, "utf8"), data);
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
    await packedDraftSmoke(installed, collectorArchive);
    const { createWebServer } = require(
      join(installed, "lib", "web", "server.cjs"),
    );
    const web = createWebServer({
      archive: {
        listItems: async () => [],
        getItem: async () => null,
        listAnnotations: async () => [],
      },
      owner: "fixture",
      project: "fixture",
    });
    try {
      const { port } = await web.listen();
      for (const asset of [
        "/assets/cytoscape.js",
        "/assets/vis.js",
        "/assets/vis.css",
        "/graph-wiki.css",
        "/graph-wiki.js",
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}${asset}`);
        assert.equal(response.status, 200, asset);
        assert.ok((await response.text()).length > 50, asset);
      }
    } finally {
      await web.close();
    }
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
    const candidateV2 = require(
      join(installed, "lib", "candidate-contract-v2.cjs"),
    );
    assert.equal(
      existsSync(join(installed, "lib", "candidate-contract-v2.d.cts")),
      true,
    );
    assert.equal(candidateV2.PROTOCOL, "candidate-v2");
    assert.deepEqual(
      candidateV2.validateVersionedCandidates(
        { protocol: "candidate-v2", candidates: [] },
        [],
      ),
      [],
    );
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
    assert.ok(!listed.tools.some((tool) => /draft/.test(tool.name)));
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
      "Packed production dependencies passed semantic modules, draft CLI, and MCP find.",
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
