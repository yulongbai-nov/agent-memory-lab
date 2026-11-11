"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  { execFileSync } = require("node:child_process");
const { openArchive } = require("../lib/archive.cjs"),
  { sourceIdentity } = require("../lib/adapters"),
  { originalCapture } = require("../lib/originals.cjs"),
  { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");
const { addFindPreviews, excerpt } = require("../lib/find-preview.cjs");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js"),
  {
    StdioClientTransport,
  } = require("@modelcontextprotocol/sdk/client/stdio.js");
const scope = { owner: "synthetic", project: "candidate-preview" },
  other = { ...scope, project: "other" },
  source = (session) =>
    sourceIdentity({ harness: "dsh", instance: "fixture", session });
const cli = (dir, ...args) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, "../bin/memory.cjs"),
        ...args,
        "--dir",
        dir,
        "--owner",
        scope.owner,
        "--project",
        scope.project,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } },
    ),
  );
const strip = (result) => ({
  ...result,
  topics: result.topics.map((row) => {
    const topic = { ...row };
    for (const key of [
      "groupLabels",
      "matchedItems",
      "previewCitations",
      "preview",
    ])
      delete topic[key];
    return topic;
  }),
});
test("CLI opt-in preserves groups and deduplicates old matching revisions in both stores", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "find-preview-fixture-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const archive = await openArchive({ dir }),
    a = source("lantern-a"),
    item = {
      id: "same-item",
      kind: "message",
      role: "user",
      text: "灯展：无障碍导览的盲文地图还要校对。",
      time: "2026-07-06T09:00:00.000Z",
    };
  const append = (s, src, position, previous, record) =>
    archive.importBatch({
      scope: s,
      source: src,
      checkpoint: { position, previous },
      items: [record],
    });
  const versions = [];
  await append(scope, a, 1, null, item);
  versions.push(
    (await archive.getItem({ ...scope, source: a, id: item.id })).versionId,
  );
  for (const n of [2, 3]) {
    const original = await originalCapture(dir)({
      bytes: Buffer.from(
        JSON.stringify({
          text: item.text,
          fixtureMarker: `ORIGINAL_ONLY_${n}`,
        }) + "\n",
      ),
      coordinate: n,
    });
    await append(scope, a, n, n - 1, { ...item, original });
    versions.push(
      (await archive.getItem({ ...scope, source: a, id: item.id })).versionId,
    );
  }
  await append(scope, a, 4, 3, {
    ...item,
    id: "different-item",
    role: "assistant",
    text: "灯展：入口需要两张路线示意图。",
    time: "2026-07-09T09:00:00.000Z",
  });
  await append(scope, a, 5, 4, {
    ...item,
    text: "改为核对入口导览牌。",
    time: "2026-07-10T09:00:00.000Z",
  });
  for (let i = 1; i <= 5; i++)
    await append(scope, source(`lantern-${i}`), 1, null, {
      ...item,
      text: `灯展：确认第${i}个展位的安排。`,
      time: `2026-07-0${i}T09:00:00.000Z`,
    });
  await append(other, a, 1, null, {
    ...item,
    text: "灯展：外域文字。",
    time: "2026-07-11T09:00:00.000Z",
  });
  const inspect = () => {
    const plain = cli(dir, "find", "--keyword", "灯展"),
      preview = cli(dir, "find", "--keyword", "灯展", "--preview");
    assert.deepEqual(strip(preview), plain);
    assert.equal(preview.topics.length, 5);
    const top = preview.topics[0];
    assert.equal(top.count, 4);
    assert.equal(top.matchedItems, 2);
    assert.equal(top.previewCitations.length, 2);
    assert.deepEqual(top.groupLabels, ["来源会话"]);
    assert.equal(top.preview.label, "归档消息");
    assert.equal(top.preview.selection, "关键词命中片段");
    assert.equal(top.preview.text, item.text);
    assert.equal(top.preview.originalAvailability, "archived-recorded");
    assert.ok(versions.slice(1).includes(top.preview.citation.revision));
    assert.ok(!top.previewCitations.some((c) => c.revision === versions[0]));
    assert.ok(!JSON.stringify(preview).includes("ORIGINAL_ONLY"));
    assert.ok(!JSON.stringify(preview).includes("外域文字"));
    assert.ok(!JSON.stringify(preview).includes("改为核对入口导览牌"));
    return preview;
  };
  const first = inspect();
  await migrateJsonToSqlite({ dir });
  assert.deepEqual(inspect(), first);
  const date = cli(
    dir,
    "find",
    "--from",
    "2026-07-06T00:00:00.000Z",
    "--to",
    "2026-07-09T23:59:59.000Z",
    "--preview",
  );
  assert.ok(
    date.topics.every((x) => x.preview?.selection === "时间范围内片段"),
  );
  const client = new Client({ name: "synthetic-preview-check", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(__dirname, "../bin/memory.cjs"),
        "mcp",
        "--dir",
        dir,
        "--owner",
        scope.owner,
        "--project",
        scope.project,
      ],
      env: { PATH: process.env.PATH, HOME: dir },
    }),
  );
  try {
    const result = await client.callTool({
      name: "memory_find",
      arguments: { keyword: "灯展" },
    });
    assert.ok(!JSON.stringify(result).includes("previewCitations"));
    assert.ok(!JSON.stringify(result).includes("groupLabels"));
  } finally {
    await client.close();
    archive.close?.();
  }
});
test("metadata/tool-only, mixed grouping and source identities do not invent previews", async () => {
  const s = { owner: "synthetic", project: "p" },
    a = { harness: "dsh", instance: "i", session: "s1" },
    b = { ...a, session: "s2" },
    ref = (src, id, v, item) => ({
      scope: s,
      source: src,
      versionId: v,
      item: { id, ...item },
    });
  const rows = [
    ref(a, "same", "v1", {
      kind: "message",
      role: "user",
      text: "只是普通内容",
      metadata: { topic: "同组" },
      time: "2026-01-01",
    }),
    ref(b, "same", "v2", {
      kind: "message",
      role: "assistant",
      text: "关键字：第二来源",
      metadata: { topic: "同组" },
      time: "2026-01-02",
    }),
    ref(a, "tool", "v3", {
      kind: "tool_result",
      text: "关键字：工具内容",
      metadata: { topic: "工具命中" },
      time: "2026-01-03",
    }),
    ref(a, "meta", "v4", {
      kind: "event",
      title: "关键字",
      metadata: { topic: "元数据命中" },
      time: "2026-01-04",
    }),
  ];
  const archive = {
    listItems: async () => rows,
    listAnnotations: async () => [
      {
        kind: "todo",
        topic: "审核命中",
        text: "关键字",
        target: { id: "same", revision: "v1", source: a },
      },
    ],
    getItem: async (x) =>
      rows.find((r) => r.item.id === x.id && r.versionId === x.revision) ||
      null,
  };
  const base = {
    topics: ["同组", "工具命中", "元数据命中", "审核命中"].map((topic) => ({
      topic,
      count: 1,
      latest: "",
      citations: [],
    })),
    coverage: {},
  };
  const result = await addFindPreviews(archive, s, { keyword: "关键字" }, base);
  const [mixed, tool, meta, review] = result.topics;
  assert.equal(mixed.matchedItems, 1);
  assert.equal(mixed.preview.text, "关键字：第二来源");
  assert.equal(mixed.preview.originalAvailability, "source-only");
  for (const x of [tool, meta, review]) assert.equal(x.preview, null);
  assert.equal(review.matchedItems, 1);
  const all = await addFindPreviews(archive, s, {}, base);
  assert.equal(all.topics[0].matchedItems, 2);
  assert.equal(all.topics[0].previewCitations.length, 2);
  const joined = [a.harness, a.instance, a.session].join(" / ");
  const dualRows = [
    ref(a, "same", "v5", {
      kind: "message",
      role: "user",
      text: "关键字来源一",
    }),
    ref(b, "same", "v6", {
      kind: "message",
      role: "assistant",
      text: "关键字来源二",
      metadata: { topic: joined },
    }),
    {
      ...ref(a, "same", "v7", {
        kind: "message",
        role: "user",
        text: "关键字外域",
      }),
      scope: { ...s, project: "foreign" },
    },
  ];
  const dual = await addFindPreviews(
    {
      ...archive,
      listItems: async () => dualRows,
      listAnnotations: async () => [],
    },
    s,
    { keyword: "关键字" },
    {
      topics: [{ topic: joined, count: 2, latest: "", citations: [] }],
      coverage: {},
    },
  );
  assert.deepEqual(dual.topics[0].groupLabels, ["命名话题", "来源会话"]);
  assert.equal(dual.topics[0].matchedItems, 2);
  assert.equal(dual.topics[0].previewCitations.length, 2);
  assert.ok(!JSON.stringify(dual).includes("关键字外域"));
});
test("excerpt preserves Unicode scalar boundaries and JSON escapes control characters", () => {
  const input =
    "前缀" + "😀灯".repeat(100) + "关键字" + "尾".repeat(120) + "\u0000\n";
  const result = excerpt(input, "关键字");
  assert.ok(result);
  assert.ok(Buffer.byteLength(result.text) <= 240);
  assert.ok(input.includes(result.text));
  assert.ok(result.text.includes("关键字"));
  assert.equal(result.truncated, true);
  assert.equal(result.text.isWellFormed(), true);
  const control = excerpt("关键字\u0000\n结束", "关键字");
  assert.equal(JSON.parse(JSON.stringify(control)).text, "关键字\u0000\n结束");
  assert.match(JSON.stringify(control), /\\u0000/);
  assert.equal(excerpt("坏\ud800关键字", "关键字"), null);
  assert.equal(excerpt("关键字 token=synthetic-secret-value", "关键字"), null);
  assert.equal(excerpt("关键字 synthetic@example.invalid", "关键字"), null);
  assert.equal(excerpt("灯".repeat(100), "灯".repeat(100)), null);
});
test("CLI handles casefold expansion, matching named-review targets and terminal escapes in both backends", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "find-preview-regression-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const archive = await openArchive({ dir }),
    foldSource = source("fold"),
    manualSource = source("manual"),
    controlSource = source("control");
  const folded = "前".repeat(25) + "İ" + "a".repeat(238) + "尾".repeat(50),
    keyword = "\u0307" + "a".repeat(238),
    control = "terminal\u009b\u202eend";
  for (const [src, item] of [
    [
      foldSource,
      {
        id: "fold",
        kind: "message",
        role: "user",
        text: folded,
        time: "2026-01-01T00:00:00Z",
      },
    ],
    [
      manualSource,
      {
        id: "manual",
        kind: "message",
        role: "user",
        text: "clue: agreed plan",
        time: "2026-01-02T00:00:00Z",
      },
    ],
    [
      controlSource,
      {
        id: "control",
        kind: "message",
        role: "assistant",
        text: control,
        time: "2026-01-03T00:00:00Z",
      },
    ],
  ])
    await archive.importBatch({
      scope,
      source: src,
      checkpoint: { position: 1 },
      items: [item],
    });
  const row = await archive.getItem({
    ...scope,
    source: manualSource,
    id: "manual",
  });
  await archive.addAnnotation({
    scope,
    id: "review",
    kind: "decision",
    topic: "Manual",
    text: "confirmed",
    target: { id: "manual", revision: row.versionId, source: manualSource },
  });
  const inspect = () => {
    const foldedResult = cli(dir, "find", "--keyword", keyword, "--preview");
    assert.equal(foldedResult.topics.length, 1);
    const p = foldedResult.topics[0].preview;
    assert.ok(p);
    assert.equal(p.text, "İ" + "a".repeat(238));
    assert.equal(Buffer.byteLength(p.text), 240);
    const manual = cli(dir, "find", "--keyword", "clue", "--preview"),
      named = manual.topics.find((x) => x.topic === "Manual");
    assert.ok(named);
    assert.equal(named.preview.text, "clue: agreed plan");
    assert.equal(named.preview.citation.revision, row.versionId);
    const argv = [
        path.join(__dirname, "../bin/memory.cjs"),
        "find",
        "--keyword",
        "terminal",
        "--preview",
        "--dir",
        dir,
        "--owner",
        scope.owner,
        "--project",
        scope.project,
      ],
      wire = execFileSync(process.execPath, argv, {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: dir },
      });
    assert.ok(!wire.includes("\u009b"));
    assert.ok(!wire.includes("\u202e"));
    assert.match(wire, /\\u009b/);
    assert.match(wire, /\\u202e/);
    assert.equal(JSON.parse(wire).topics[0].preview.text, control);
    return { foldedResult, manual, parsed: JSON.parse(wire) };
  };
  const before = inspect();
  await migrateJsonToSqlite({ dir });
  assert.deepEqual(inspect(), before);
  archive.close?.();
});
