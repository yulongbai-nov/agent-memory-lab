"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { openArchive } = require("../lib/archive.cjs");
const { originalCapture } = require("../lib/originals.cjs");
const { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");
const { projectionChoices } = require("../lib/local-derive-selection.cjs");
const { verifiedProjections } = require("../lib/local-derive-projection.cjs");

const scope = { owner: "synthetic", project: "draft-read" };
const source = { harness: "dsh", instance: "fixture", session: "source-a" };
const body = "纸鹤决定采用 JSONL。下一步补齐截图断言 🐦。";
const sha = (input) => createHash("sha256").update(input).digest("hex");

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "local-draft-read-"));
  let archive = await openArchive({ dir });
  t.after(async () => {
    archive.close?.();
    await fs.rm(dir, { force: true, recursive: true });
  });
  const capture = originalCapture(dir);
  const folder = join(dir, "local-derive");
  const scopeKey = sha(JSON.stringify([scope.owner, scope.project]));
  const latest = join(folder, `latest-${scopeKey}.json`);
  const cmd = (args, selected = scope) => {
    const result = spawnSync(
      process.execPath,
      [
        join(__dirname, "../bin/memory.cjs"),
        ...args,
        "--dir",
        dir,
        "--owner",
        selected.owner,
        "--project",
        selected.project,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "");
    return {
      code: result.status,
      output: JSON.parse(result.stdout),
      raw: result.stdout,
    };
  };
  const append = async (
    text,
    {
      selected = scope,
      harness = source,
      rawText = text,
      withOriginal = true,
    } = {},
  ) => {
    const id = "synthetic-colliding-item";
    const previous = (await archive.getCheckpoint({ ...selected, ...harness }))
      ?.position;
    const position = (previous ?? 0) + 1;
    const original = withOriginal
      ? await capture({
          coordinate: position,
          bytes: Buffer.from(
            JSON.stringify({
              type: "user/message",
              data: { role: "user", text: rawText },
            }) + "\n",
          ),
        })
      : undefined;
    await archive.importBatch({
      scope: selected,
      source: harness,
      checkpoint: { position, ...(previous !== undefined && { previous }) },
      items: [
        {
          id,
          kind: "message",
          role: "user",
          text,
          metadata: { ...(original && { original }) },
        },
      ],
    });
    return archive.getItem({ ...selected, id, source: harness });
  };
  const row = await append(body);
  await migrateJsonToSqlite({ dir });
  archive = await openArchive({ dir });
  const makeDraft = async ({
    record = row,
    claim = "补齐截图断言",
    quote = "下一步补齐截图断言 🐦。",
    legacy = false,
  } = {}) => {
    const citation = {
      source: Object.values(record.source).slice(0, 3).join("/"),
      item: record.item.id,
      version: record.versionId,
    };
    const choices = projectionChoices(record.item.text);
    const match = (await verifiedProjections(dir, record, choices)).find(
      (choice) => choice.text.includes(quote),
    );
    const evidence = { ...citation, quote };
    const inputProjections = [];
    if (!legacy) {
      assert.ok(match);
      const at = match.text.indexOf(quote);
      const projection = match.projection;
      const byteAt =
        projection.startUtf8 + Buffer.byteLength(match.text.slice(0, at));
      inputProjections.push({ ...citation, ...projection });
      evidence.originalSpan = {
        ...projection,
        startUtf16: projection.startUtf16 + at,
        endUtf16: projection.startUtf16 + at + quote.length,
        startUtf8: byteAt,
        endUtf8: byteAt + Buffer.byteLength(quote),
        previewStartUtf16: projection.previewStartUtf16 + at,
        previewEndUtf16: projection.previewStartUtf16 + at + quote.length,
      };
    }
    return {
      runtime: "macos-offline-private",
      scopeKey,
      generatedAt: "2026-01-01T00:00:00.000Z",
      draftFile: `draft-${"a".repeat(64)}.txt`,
      ...(legacy ? {} : { inputProjections }),
      candidates: [
        { kind: "todo", status: "待核实", claim, evidence: [evidence] },
      ],
    };
  };
  const publish = async (draft) => {
    await fs.mkdir(folder, { mode: 0o700, recursive: true });
    const staged = join(folder, "synthetic-pending");
    await fs.writeFile(staged, JSON.stringify(draft), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(staged, latest);
  };
  const list = () => cmd(["draft-list"]);
  const show = (id = list().output.candidates[0].id) =>
    cmd(["draft-show", "--id", id]);
  return {
    dir,
    folder,
    latest,
    row,
    cmd,
    append,
    makeDraft,
    publish,
    list,
    show,
    approved: () => archive.listAnnotations(scope),
    original: (record = row) =>
      join(dir, "originals", record.item.metadata.original.sha256 + ".jsonl"),
  };
}

test("versioned candidates publish and explicit decision/todo reviews retain lineage", async (t) => {
  const f = await fixture(t),
    draft = await f.makeDraft(),
    base = draft.candidates[0],
    candidate = {
      kind: "decision",
      basis: "uncertain",
      claim: base.claim,
      evidence: base.evidence,
    },
    todo = { kind: "todo", claim: "Follow up", evidence: base.evidence },
    receipt = {
      formatVersion: 2,
      scope,
      producer: {
        writerProtocol: "test-writer",
        recipeIdentity: "b".repeat(64),
        outputProtocol: "candidate-v2",
      },
      generatedAt: "2026-01-01T00:00:00Z",
      inputProjections: draft.inputProjections,
      candidates: [candidate, todo],
    },
    bytes = Buffer.from(JSON.stringify(receipt)),
    file = join(f.dir, "receipt.json");
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const published = f.cmd([
    "draft-publish",
    "--receipt",
    file,
    "--receipt-sha256",
    sha(bytes),
    "--expect-latest",
    "none",
  ]);
  assert.equal(published.code, 0);
  const snapshot = published.output.snapshot;
  const list = f.cmd(["draft-list", "--format", "v2"]).output;
  assert.equal(list.status, "ready");
  assert.equal(list.generatedAt, "2026-01-01T00:00:00Z");
  assert.equal(list.candidates[0].basis, "uncertain");
  const show = f.cmd([
    "draft-show",
    "--format",
    "v2",
    "--id",
    snapshot + ":1",
  ]).output;
  assert.equal(show.candidate.evidence[0].quoteStatus, "verified-original");
  assert.equal(show.generatedAt, "2026-01-01T00:00:00Z");
  const decision = f.cmd([
    "draft-review",
    "--id",
    snapshot + ":1",
    "--text",
    "Operator confirms test decision",
    "--topic",
    "Synthetic",
    "--basis",
    "proposed",
  ]);
  assert.equal(decision.code, 0);
  assert.equal(decision.output.basis, "proposed");
  assert.match(decision.output.reviewedAt, /^\d{4}-\d\d-\d\dT/);
  const replay = f.cmd([
    "draft-review",
    "--id",
    snapshot + ":1",
    "--text",
    "Operator confirms test decision",
    "--topic",
    "Synthetic",
    "--basis",
    "proposed",
  ]);
  assert.deepEqual(replay.output, decision.output);
  const showReview = f.cmd([
    "draft-review-show",
    "--review-id",
    decision.output.id,
  ]).output;
  assert.equal(showReview.snapshotStatus, "verified");
  assert.equal(showReview.review.reviewedAt, decision.output.reviewedAt);
  const queryArchive = await openArchive({ dir: f.dir, readOnly: true });
  try {
    const visible = await require("../lib/query.cjs")
        .createQuery(queryArchive)
        .annotations(scope),
      entry = visible.find((x) => x.id === decision.output.id);
    assert.equal("candidateReview" in entry, false);
    assert.equal(entry.candidateLineage.candidateId, snapshot + ":1");
  } finally {
    queryArchive.close?.();
  }
  const current = f.cmd(["current", "--topic", "Synthetic"]).output;
  assert.equal(current[0].label, "待决定");
  assert.equal(current[0].candidateLineage.candidateId, snapshot + ":1");
  const reviewedTodo = f.cmd([
    "draft-review",
    "--id",
    snapshot + ":2",
    "--text",
    "Operator task",
    "--topic",
    "Synthetic",
  ]);
  assert.equal(reviewedTodo.code, 0);
  const tasks = f.cmd(["task-list"]).output.tasks;
  assert.ok(
    tasks.some(
      (x) =>
        x.root.id === reviewedTodo.output.id &&
        x.candidateLineage.candidateId === snapshot + ":2",
    ),
  );
  const task = tasks.find((x) => x.root.id === reviewedTodo.output.id);
  const completed = f.cmd([
    "annotate",
    "--id",
    "synthetic-completion",
    "--kind",
    "task-state",
    "--target",
    JSON.stringify(task.target),
    "--task-root",
    JSON.stringify(task.root),
    "--parents",
    "[]",
    "--state",
    "completed",
    "--evidence-kind",
    "operator",
    "--text",
    "Completed by operator",
  ]);
  assert.equal(completed.code, 0);
  assert.equal(
    f
      .cmd(["task-list"])
      .output.tasks.some((x) => x.root.id === reviewedTodo.output.id),
    false,
  );
  const timeline = f
    .cmd(["timeline", "--topic", "Synthetic"])
    .output.rows.find((x) => x.review_id === reviewedTodo.output.id);
  assert.equal(timeline.next_step, null);
  assert.equal(timeline.candidateLineage.candidateId, snapshot + ":2");
  const archive = await openArchive({ dir: f.dir, readOnly: true });
  try {
    const graph =
      await require("../lib/ontology-projection.cjs").rebuildProjection({
        archive,
        scope,
        asOf: "2026-12-01T00:00:00Z",
        dependencies: [],
      });
    assert.equal(
      graph.nodes.find((x) => x.id === decision.output.id).candidateLineage
        .candidateId,
      snapshot + ":1",
    );
  } finally {
    archive.close?.();
  }
  await f.append("A later synthetic revision.");
  const oldSource = f.cmd([
    "draft-show",
    "--format",
    "v2",
    "--id",
    snapshot + ":1",
  ]).output;
  assert.equal(oldSource.candidate.evidence[0].sourceStatus, "older-version");
  const oldReview = f.cmd([
    "draft-review-show",
    "--review-id",
    decision.output.id,
  ]).output;
  assert.equal(oldReview.candidate.evidence[0].sourceStatus, "older-version");
  assert.equal(
    oldReview.candidate.evidence[0].version,
    draft.candidates[0].evidence[0].version,
  );
  const snapshotFile = join(
      f.dir,
      "local-derive",
      "draft-v2",
      sha(JSON.stringify([scope.owner, scope.project])),
      "snapshots",
      snapshot + ".json",
    ),
    backup = snapshotFile + ".saved";
  await fs.rename(snapshotFile, backup);
  let detail = f.cmd([
    "draft-review-show",
    "--review-id",
    decision.output.id,
  ]).output;
  assert.equal(detail.snapshotStatus, "missing");
  assert.equal(detail.candidate.evidence[0].quoteStatus, "verified-original");
  await fs.writeFile(snapshotFile, "{}", { mode: 0o600 });
  detail = f.cmd([
    "draft-review-show",
    "--review-id",
    decision.output.id,
  ]).output;
  assert.equal(detail.snapshotStatus, "invalid");
  await fs.rm(snapshotFile);
  await fs.rename(backup, snapshotFile);
  const original = f.original();
  await fs.rename(original, original + ".saved");
  detail = f.cmd([
    "draft-review-show",
    "--review-id",
    decision.output.id,
  ]).output;
  assert.equal(
    detail.candidate.evidence[0].quoteStatus,
    "archived-preview-only",
  );
  assert.equal("originalSpan" in detail.candidate.evidence[0], false);
  await fs.rename(original + ".saved", original);
  const { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(join(f.dir, "archive.sqlite3")),
    identity = JSON.stringify([scope.owner, scope.project, decision.output.id]),
    saved = db
      .prepare("SELECT data FROM annotations WHERE identity=?")
      .get(identity).data,
    tampered = JSON.parse(saved);
  tampered.candidateReview.primary = 2;
  db.prepare("UPDATE annotations SET data=? WHERE identity=?").run(
    JSON.stringify(tampered),
    identity,
  );
  db.close();
  const invalid = spawnSync(
    process.execPath,
    [
      join(__dirname, "../bin/memory.cjs"),
      "draft-review-show",
      "--dir",
      f.dir,
      "--owner",
      scope.owner,
      "--project",
      scope.project,
      "--review-id",
      decision.output.id,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  const changed = JSON.parse(saved);
  changed.scope.owner = "different-owner";
  const otherDb = new DatabaseSync(join(f.dir, "archive.sqlite3"));
  otherDb
    .prepare("UPDATE annotations SET data=? WHERE identity=?")
    .run(JSON.stringify(changed), identity);
  otherDb.close();
  const foreign = spawnSync(
    process.execPath,
    [
      join(__dirname, "../bin/memory.cjs"),
      "draft-review-show",
      "--dir",
      f.dir,
      "--owner",
      scope.owner,
      "--project",
      scope.project,
      "--review-id",
      decision.output.id,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(foreign.status, 0);
  assert.equal(foreign.stdout, "");
});

test("versioned declared full projection accepts long repeated source text by exact offsets", async (t) => {
  const f = await fixture(t),
    text = "Repeat evidence. " + "x ".repeat(300) + "Repeat evidence.",
    row = await f.append(text),
    start = text.lastIndexOf("Repeat evidence."),
    quote = "Repeat evidence.",
    p = {
      source: Object.values(row.source).slice(0, 3).join("/"),
      item: row.item.id,
      version: row.versionId,
      kind: "full",
      fieldPath: "data.text",
      originalSha256: row.item.metadata.original.sha256,
      startUtf16: 0,
      endUtf16: text.length,
      startUtf8: 0,
      endUtf8: Buffer.byteLength(text),
      previewStartUtf16: 0,
      previewEndUtf16: text.length,
    },
    q = {
      ...p,
      startUtf16: start,
      endUtf16: start + quote.length,
      startUtf8: Buffer.byteLength(text.slice(0, start)),
      endUtf8: Buffer.byteLength(text.slice(0, start + quote.length)),
      previewStartUtf16: start,
      previewEndUtf16: start + quote.length,
    };
  delete q.source;
  delete q.item;
  delete q.version;
  const receipt = {
      formatVersion: 2,
      scope,
      producer: {
        writerProtocol: "generic-test",
        recipeIdentity: "c".repeat(64),
        outputProtocol: "candidate-v2",
      },
      generatedAt: null,
      inputProjections: [p],
      candidates: [
        {
          kind: "decision",
          basis: "confirmed",
          claim: "Synthetic repeated evidence",
          evidence: [
            {
              source: p.source,
              item: p.item,
              version: p.version,
              quote,
              originalSpan: q,
            },
          ],
        },
      ],
    },
    bytes = Buffer.from(JSON.stringify(receipt)),
    file = join(f.dir, "long-receipt.json");
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const r = f.cmd([
    "draft-publish",
    "--receipt",
    file,
    "--receipt-sha256",
    sha(bytes),
    "--expect-latest",
    "none",
  ]);
  assert.equal(r.code, 0);
  const d = f.cmd([
    "draft-show",
    "--format",
    "v2",
    "--id",
    r.output.snapshot + ":1",
  ]).output;
  assert.equal(d.candidate.evidence[0].quoteStatus, "verified-original");
  assert.equal(d.candidate.evidence[0].originalSpan.startUtf16, start);
});

test("review capsule includes only the chosen candidate projection for a shared source", async (t) => {
  const f = await fixture(t),
    text = "Alpha phrase. Beta phrase.",
    row = await f.append(text),
    sourceId = Object.values(row.source).slice(0, 3).join("/");
  const projection = (start, end) => ({
    source: sourceId,
    item: row.item.id,
    version: row.versionId,
    kind: "fragment",
    fieldPath: "data.text",
    originalSha256: row.item.metadata.original.sha256,
    startUtf16: start,
    endUtf16: end,
    startUtf8: Buffer.byteLength(text.slice(0, start)),
    endUtf8: Buffer.byteLength(text.slice(0, end)),
    previewStartUtf16: start,
    previewEndUtf16: end,
  });
  const p1 = projection(0, 13),
    p2 = projection(14, text.length),
    evidence = (p) => {
      const { source, item, version, ...originalSpan } = p;
      return {
        source,
        item,
        version,
        quote: text.slice(p.previewStartUtf16, p.previewEndUtf16),
        originalSpan,
      };
    };
  const receipt = {
      formatVersion: 2,
      scope,
      producer: {
        writerProtocol: "generic",
        recipeIdentity: "d".repeat(64),
        outputProtocol: "candidate-v2",
      },
      generatedAt: null,
      inputProjections: [p1, p2],
      candidates: [
        {
          kind: "decision",
          basis: "confirmed",
          claim: "Alpha",
          evidence: [evidence(p1)],
        },
        {
          kind: "decision",
          basis: "uncertain",
          claim: "Beta",
          evidence: [evidence(p2)],
        },
      ],
    },
    bytes = Buffer.from(JSON.stringify(receipt)),
    file = join(f.dir, "shared.json");
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const published = f.cmd([
    "draft-publish",
    "--receipt",
    file,
    "--receipt-sha256",
    sha(bytes),
    "--expect-latest",
    "none",
  ]).output;
  const accepted = f.cmd([
    "draft-review",
    "--id",
    published.snapshot + ":1",
    "--text",
    "Reviewed alpha",
    "--topic",
    "Alpha",
    "--basis",
    "confirmed",
  ]).output;
  const archive = await openArchive({ dir: f.dir, readOnly: true });
  try {
    const annotation = await archive.getAnnotation({
      ...scope,
      id: accepted.id,
    });
    assert.equal(annotation.candidateReview.inputProjections.length, 1);
    assert.equal(
      annotation.candidateReview.inputProjections[0].previewStartUtf16,
      0,
    );
  } finally {
    archive.close?.();
  }
});

test("declared preview does not expose tool or turn-event text", () => {
  const {
      previewDeclaredProjection,
    } = require("../lib/local-derive-projection.cjs"),
    p = { kind: "full", previewStartUtf16: 0, previewEndUtf16: 4 },
    source = { harness: "dsh" },
    safe = {
      source,
      item: {
        kind: "message",
        role: "user",
        text: "safe",
        metadata: { recordType: "user/message" },
      },
    };
  assert.equal(previewDeclaredProjection(safe, p), "safe");
  for (const item of [
    { ...safe.item, kind: "event" },
    { ...safe.item, role: "tool" },
    { ...safe.item, metadata: { recordType: "turn/end" } },
  ])
    assert.equal(previewDeclaredProjection({ source, item }, p), null);
});

test("SQLite evidence lookup preserves explicit nonmessage type for v2 gate parity", async (t) => {
  const f = await fixture(t),
    archive = await openArchive({ dir: f.dir }),
    other = { harness: "dsh", instance: "fixture", session: "malformed" },
    text = "safe",
    original = await originalCapture(f.dir)({
      coordinate: 1,
      bytes: Buffer.from(
        JSON.stringify({ type: "user/message", data: { role: "user", text } }) +
          "\n",
      ),
    });
  try {
    await archive.importBatch({
      scope,
      source: other,
      checkpoint: { position: 1 },
      items: [
        {
          id: "malformed",
          kind: "message",
          role: "user",
          text,
          metadata: { recordType: "tool/result", original },
        },
      ],
    });
    const row = await archive.getItem({
        ...scope,
        source: other,
        id: "malformed",
      }),
      selected = await archive.lookupDraftEvidence({
        ...scope,
        source: other,
        id: "malformed",
        revision: row.versionId,
      }),
      p = { kind: "full", previewStartUtf16: 0, previewEndUtf16: 4 };
    const {
      previewDeclaredProjection,
    } = require("../lib/local-derive-projection.cjs");
    assert.equal(selected.row.item.metadata.recordType, "tool/result");
    assert.equal(previewDeclaredProjection(row, p), null);
    assert.equal(previewDeclaredProjection(selected.row, p), null);
    const projection = {
      source: [other.harness, other.instance, other.session].join("/"),
      item: "malformed",
      version: row.versionId,
      kind: "full",
      fieldPath: "data.text",
      originalSha256: original.sha256,
      startUtf16: 0,
      endUtf16: 4,
      startUtf8: 0,
      endUtf8: 4,
      previewStartUtf16: 0,
      previewEndUtf16: 4,
    };
    const { source, item, version, ...span } = projection,
      receipt = {
        formatVersion: 2,
        scope,
        producer: {
          writerProtocol: "generic",
          recipeIdentity: "f".repeat(64),
          outputProtocol: "candidate-v2",
        },
        generatedAt: null,
        inputProjections: [projection],
        candidates: [
          {
            kind: "decision",
            basis: "confirmed",
            claim: "Synthetic",
            evidence: [
              { source, item, version, quote: text, originalSpan: span },
            ],
          },
        ],
      },
      bytes = Buffer.from(JSON.stringify(receipt)),
      file = join(f.dir, "bad-type.json");
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        join(__dirname, "../bin/memory.cjs"),
        "draft-publish",
        "--dir",
        f.dir,
        "--owner",
        scope.owner,
        "--project",
        scope.project,
        "--receipt",
        file,
        "--receipt-sha256",
        sha(bytes),
        "--expect-latest",
        "none",
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    archive.close?.();
  }
});

test("empty candidate receipt drops unused input projections", async (t) => {
  const f = await fixture(t),
    draft = await f.makeDraft(),
    receipt = {
      formatVersion: 2,
      scope,
      producer: {
        writerProtocol: "generic",
        recipeIdentity: "e".repeat(64),
        outputProtocol: "candidate-v2",
      },
      generatedAt: null,
      inputProjections: draft.inputProjections,
      candidates: [],
    },
    bytes = Buffer.from(JSON.stringify(receipt)),
    file = join(f.dir, "empty.json");
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const published = f.cmd([
    "draft-publish",
    "--receipt",
    file,
    "--receipt-sha256",
    sha(bytes),
    "--expect-latest",
    "none",
  ]).output;
  assert.equal(f.cmd(["draft-list", "--format", "v2"]).output.status, "empty");
  const snapshotFile = join(
      f.dir,
      "local-derive",
      "draft-v2",
      sha(JSON.stringify([scope.owner, scope.project])),
      "snapshots",
      published.snapshot + ".json",
    ),
    snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8"));
  assert.deepEqual(snapshot.inputProjections, []);
});

test("v2 verifies only corroborated input in a legacy Codex wrapper", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "legacy-declared-review-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const {
    previewDeclaredProjection,
    verifyDeclaredProjection,
  } = require("../lib/local-derive-projection.cjs");
  const capture = originalCapture(dir);
  const input = "合成决定保留两个检查步骤 🐦。";
  const context = "Context must never become a candidate quote.";
  const wrapper = (userLine) =>
    `<realtime_delegation><input>${input}</input>` +
    `<transcript_delta>assistant: ${context}\n${userLine}` +
    `</transcript_delta></realtime_delegation>`;
  async function fixture(
    text,
    role = "user",
    content = [{ type: "input_text", text }],
    rawRole = role,
  ) {
    const original = await capture({
      coordinate: 1,
      bytes: Buffer.from(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: rawRole,
            content,
          },
        }),
      ),
    });
    return {
      source: { harness: "codex" },
      item: {
        kind: "message",
        role,
        text,
        metadata: { recordType: "response_item:message", original },
      },
    };
  }
  function span(row, quote) {
    const { text, metadata } = row.item;
    const start = text.indexOf(quote);
    const end = start + quote.length;
    return {
      kind: "relay-input",
      fieldPath: "payload.content.0.text",
      originalSha256: metadata.original.sha256,
      startUtf16: start,
      endUtf16: end,
      startUtf8: Buffer.byteLength(text.slice(0, start)),
      endUtf8: Buffer.byteLength(text.slice(0, end)),
      previewStartUtf16: start,
      previewEndUtf16: end,
    };
  }
  const valid = await fixture(wrapper(`user: ${input}`));
  const selected = span(valid, input);
  assert.equal(previewDeclaredProjection(valid, selected), input);
  assert.deepEqual(await verifyDeclaredProjection(dir, valid, selected), {
    status: "verified",
    text: input,
  });
  const rawText = valid.item.text;
  for (const selectedPart of [
    { type: "output_text", text: rawText },
    { type: "text", text: rawText },
    { text: rawText },
    rawText,
  ]) {
    const bad = await fixture(rawText, "user", [
      selectedPart,
      { type: "input_text", text: "unrelated" },
    ]);
    assert.deepEqual(
      await verifyDeclaredProjection(dir, bad, span(bad, input)),
      { status: "integrity-failed" },
    );
  }
  const duplicate = await fixture(rawText, "user", [
    { type: "input_text", text: rawText },
    { type: "input_text", text: "unrelated" },
  ]);
  assert.deepEqual(
    await verifyDeclaredProjection(dir, duplicate, span(duplicate, input)),
    { status: "integrity-failed" },
  );
  const wrongRole = await fixture(
    rawText,
    "user",
    [{ type: "input_text", text: rawText }],
    "assistant",
  );
  assert.deepEqual(
    await verifyDeclaredProjection(dir, wrongRole, span(wrongRole, input)),
    { status: "integrity-failed" },
  );
  const nonzero = await fixture(rawText, "user", [
    { type: "output_text", text: "unrelated" },
    { type: "input_text", text: rawText },
  ]);
  assert.deepEqual(
    await verifyDeclaredProjection(dir, nonzero, {
      ...span(nonzero, input),
      fieldPath: "payload.content.1.text",
    }),
    { status: "verified", text: input },
  );
  const legacy = (value, transcript) =>
    `<realtime_delegation><input>${value}</input>` +
    `<transcript_delta>${transcript}</transcript_delta></realtime_delegation>`;
  for (const [value, transcript, quote] of [
    [
      '{"type":"transcript_delta","text":"We decided to test."}',
      'user: {"type":"transcript_delta","text":"We decided to test."}',
      "We decided to test.",
    ],
    [
      "Visit https://example.test/path now",
      "user: Visit https://example.test/path now",
      "Visit",
    ],
    ["Use ports 12", "user: Use ports 1,2", "Use ports 12"],
    ["Use key ABC", "user: Use key abc", "Use key ABC"],
    [
      "Deploy production",
      "user: Deploy production\nonly after tests pass.",
      "Deploy production",
    ],
    ["Proceed", "user: Proceed\nassistant: Later", "Proceed"],
    ["Proceed", "user: Proceed\nunknown: ambiguous", "Proceed"],
  ]) {
    const bad = await fixture(legacy(value, transcript));
    assert.equal(previewDeclaredProjection(bad, span(bad, quote)), null);
    assert.deepEqual(
      await verifyDeclaredProjection(dir, bad, span(bad, quote)),
      { status: "integrity-failed" },
    );
  }
  const multilineInput = "Deploy production\nonly after tests pass.";
  const multiline = await fixture(
    legacy(
      multilineInput,
      "assistant: Earlier\r\nuser: Deploy production\r\nonly after tests pass.",
    ),
  );
  assert.deepEqual(
    await verifyDeclaredProjection(
      dir,
      multiline,
      span(multiline, multilineInput),
    ),
    { status: "verified", text: multilineInput },
  );
  assert.deepEqual(projectionChoices(valid.item.text), []);
  assert.deepEqual(
    await verifyDeclaredProjection(dir, valid, span(valid, context)),
    { status: "integrity-failed" },
  );
  for (const bad of [
    await fixture(wrapper("user: different synthetic input")),
    await fixture(wrapper(`user: ${input}`), "assistant"),
    await fixture(wrapper(`user: ${input}\n<input>ambiguous</input>`)),
  ]) {
    assert.equal(previewDeclaredProjection(bad, span(bad, input)), null);
    assert.deepEqual(
      await verifyDeclaredProjection(dir, bad, span(bad, input)),
      {
        status: "integrity-failed",
      },
    );
  }
});
