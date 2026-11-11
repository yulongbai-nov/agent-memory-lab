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

test("latest-only list and detail verify one Unicode quote without changing archive or drafts", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.list().output, {
    status: "no-draft",
    scope,
    candidates: [],
  });
  await assert.rejects(fs.lstat(f.folder), { code: "ENOENT" });
  const draft = await f.makeDraft();
  await f.publish({ ...draft, candidates: [] });
  assert.equal(f.list().output.status, "empty");
  await f.publish(draft);
  const archiveFile = join(f.dir, "archive.sqlite3");
  const files = [archiveFile, f.latest, f.original()];
  const before = await Promise.all(files.map((file) => fs.readFile(file)));
  const listed = f.list();
  assert.equal(listed.output.status, "ready");
  assert.deepEqual(listed.output.candidates, [
    {
      id: `${listed.output.snapshot}:1`,
      kind: "todo",
      status: "待核实",
      referenceCount: 1,
    },
  ]);
  assert.ok(!listed.raw.includes("截图断言"));
  const { candidate } = f.show(listed.output.candidates[0].id).output;
  assert.equal(candidate.status, "待核实");
  assert.equal(candidate.claim, draft.candidates[0].claim);
  assert.deepEqual(candidate.evidence[0], {
    ...draft.candidates[0].evidence[0],
    sourceStatus: "current",
    originalStatus: "verified",
    quoteStatus: "verified-original",
  });
  assert.deepEqual(
    await Promise.all(files.map((file) => fs.readFile(file))),
    before,
  );
  assert.deepEqual(await fs.readdir(f.folder), [f.latest.split("/").at(-1)]);
  assert.deepEqual(await f.approved(), []);
});

test("another session with the same item does not change freshness, and a real new version keeps the old quote", async (t) => {
  const f = await fixture(t);
  await f.publish(await f.makeDraft());
  await f.append("另一会话决定更改为不同的任务。", {
    harness: { ...source, session: "source-b" },
  });
  assert.equal(f.show().output.candidate.evidence[0].sourceStatus, "current");
  const replacement = await f.append("同一来源改为运行新的检查。");
  const evidence = f.show().output.candidate.evidence[0];
  assert.equal(evidence.sourceStatus, "older-version");
  assert.equal(evidence.version, f.row.versionId);
  assert.notEqual(evidence.version, replacement.versionId);
  assert.equal(evidence.quote, "下一步补齐截图断言 🐦。");
  assert.equal(evidence.quoteStatus, "verified-original");
});

test("a missing, foreign or mismatched session reference suppresses the entire claim", async (t) => {
  const f = await fixture(t);
  const secret = "只存在于另一个合成项目的内容";
  const other = { ...scope, project: "other" };
  const foreign = await f.append(secret, { selected: other });
  const draft = await f.makeDraft({ claim: secret });
  const local = draft.candidates[0].evidence[0];
  for (const bad of [
    { ...local, version: foreign.versionId, quote: secret },
    { ...local, source: "dsh/fixture/source-b" },
    { ...local, version: "b".repeat(64) },
  ]) {
    draft.candidates[0].evidence = [local, bad];
    await f.publish(draft);
    const shown = f.show();
    assert.ok(!shown.raw.includes(secret));
    assert.ok(!Object.hasOwn(shown.output.candidate, "claim"));
    assert.deepEqual(shown.output.candidate.evidence[1], {
      sourceStatus: "missing",
      originalStatus: "unknown",
      quoteStatus: "unverified",
    });
  }
  assert.equal(f.cmd(["draft-list"], other).output.status, "no-draft");
});

test("an original-only quote and a quote outside the selected projection never appear", async (t) => {
  const f = await fixture(t);
  const sensitive = "RAW-TIER-ZERO-MARKER";
  const record = await f.append(body, { rawText: `${sensitive}。${body}` });
  const draft = await f.makeDraft({ record, claim: sensitive });
  const evidence = draft.candidates[0].evidence[0];
  evidence.quote = sensitive;
  Object.assign(evidence.originalSpan, {
    startUtf16: 0,
    endUtf16: sensitive.length,
    startUtf8: 0,
    endUtf8: sensitive.length,
    previewStartUtf16: 0,
    previewEndUtf16: sensitive.length,
  });
  await f.publish(draft);
  assert.ok(!f.show().raw.includes(sensitive));
  assert.equal(f.show().output.candidate.evidence[0].quoteStatus, "unverified");
  const recordWithChoices = await f.append(
    "决定采用第一种写法。" +
      Array.from(
        { length: 16 },
        (_, n) => `这里是编号 ${n} 的普通合成段落。`,
      ).join("") +
      "下一步补齐截图断言 🐦。",
  );
  const other = await f.makeDraft({ record: recordWithChoices });
  const alt = (
    await verifiedProjections(
      f.dir,
      recordWithChoices,
      projectionChoices(recordWithChoices.item.text),
    )
  ).find((choice) => !choice.text.includes("截图断言"));
  assert.ok(alt);
  const { source: exactSource, item, version } = other.inputProjections[0];
  other.inputProjections = [
    { source: exactSource, item, version, ...alt.projection },
  ];
  await f.publish(other);
  assert.equal(f.show().output.candidate.evidence[0].quoteStatus, "unverified");
  assert.ok(!f.show().raw.includes("截图断言"));
});

test("legacy and missing originals use the eligible preview, while damaged bytes and spans hide the quote", async (t) => {
  const f = await fixture(t);
  const draft = await f.makeDraft();
  const legacy = await f.makeDraft({ legacy: true });
  await f.publish(legacy);
  assert.equal(
    f.show().output.candidate.evidence[0].quoteStatus,
    "archived-preview-only",
  );
  legacy.candidates[0].evidence[0].quote = "🐦"[0];
  await f.publish(legacy);
  assert.equal(f.show().output.candidate.evidence[0].quoteStatus, "unverified");
  const path = f.original();
  const original = await fs.readFile(path);
  await f.publish(draft);
  await fs.unlink(path);
  let evidence = f.show().output.candidate.evidence[0];
  assert.equal(evidence.originalStatus, "missing-locally");
  assert.equal(evidence.quoteStatus, "archived-preview-only");
  assert.ok(!Object.hasOwn(evidence, "originalSpan"));
  await fs.writeFile(path, Buffer.alloc(original.length, 0x20), {
    mode: 0o600,
  });
  evidence = f.show().output.candidate.evidence[0];
  assert.equal(evidence.originalStatus, "integrity-failed");
  assert.equal(evidence.quoteStatus, "unverified");
  assert.ok(!Object.hasOwn(evidence, "quote"));
  await fs.writeFile(path, original);
  draft.candidates[0].evidence[0].originalSpan.endUtf8++;
  await f.publish(draft);
  assert.equal(f.show().output.candidate.evidence[0].quoteStatus, "unverified");
  const sourceOnly = await f.append(body, { withOriginal: false });
  await f.publish(await f.makeDraft({ record: sourceOnly, legacy: true }));
  evidence = f.show().output.candidate.evidence[0];
  assert.equal(evidence.originalStatus, "source-only");
  assert.equal(evidence.quoteStatus, "archived-preview-only");
});

test("only actual absence downgrades original availability; bad size, permissions and links suppress content", async (t) => {
  const f = await fixture(t);
  await f.publish(await f.makeDraft());
  const original = f.original();
  const bytes = await fs.readFile(original);
  const expectIntegrityFailure = () => {
    const { candidate } = f.show().output;
    assert.equal(candidate.evidence[0].originalStatus, "integrity-failed");
    assert.equal(candidate.evidence[0].quoteStatus, "unverified");
    assert.ok(!Object.hasOwn(candidate.evidence[0], "quote"));
    assert.ok(!Object.hasOwn(candidate, "claim"));
  };
  await fs.writeFile(original, bytes.subarray(0, -1));
  expectIntegrityFailure();
  await fs.writeFile(original, Buffer.concat([bytes, Buffer.from("x")]));
  expectIntegrityFailure();
  await fs.writeFile(original, bytes);
  await fs.chmod(original, 0o644);
  expectIntegrityFailure();
  await fs.chmod(original, 0o600);
  await fs.rename(original, original + ".bak");
  await fs.symlink(original + ".bak", original);
  expectIntegrityFailure();
  await fs.unlink(original);
  await fs.mkdir(original, { mode: 0o700 });
  expectIntegrityFailure();
  await fs.rmdir(original);
  await fs.rename(original + ".bak", original);
  const folder = join(f.dir, "originals");
  await fs.rename(folder, folder + "-backup");
  await fs.symlink(folder + "-backup", folder);
  expectIntegrityFailure();
  await fs.unlink(folder);
  const { candidate } = f.show().output;
  assert.equal(candidate.evidence[0].originalStatus, "missing-locally");
  assert.equal(candidate.evidence[0].quoteStatus, "archived-preview-only");
});

test("snapshot replacement and deletion are stale, never a new candidate at the same position", async (t) => {
  const f = await fixture(t);
  const draft = await f.makeDraft();
  await f.publish(draft);
  const { id } = f.list().output.candidates[0];
  assert.deepEqual(f.show(id + "\n").output, { status: "invalid-input" });
  assert.deepEqual(f.show(id.replace(/1$/, "4")).output, {
    status: "candidate-not-found",
  });
  draft.candidates[0].claim = "different synthetic candidate";
  await f.publish(draft);
  assert.deepEqual(f.show(id).output, { status: "snapshot-changed" });
  assert.equal(f.show(id).code, 1);
  assert.equal(
    f.show().output.candidate.claim,
    "different synthetic candidate",
  );
  await fs.unlink(f.latest);
  assert.deepEqual(f.show(id).output, { status: "snapshot-changed" });
});

test("invalid inputs, corrupt, oversized and non-private or linked snapshots fail without content", async (t) => {
  const f = await fixture(t);
  const draft = await f.makeDraft();
  await f.publish(draft);
  assert.deepEqual(f.cmd(["draft-show", "--id", "garbage"]).output, {
    status: "invalid-input",
  });
  assert.deepEqual(f.cmd(["draft-list", "--allow-annotations"]).output, {
    status: "invalid-input",
  });
  const explicit = spawnSync(
    process.execPath,
    [
      join(__dirname, "../bin/memory.cjs"),
      "draft-list",
      "--project",
      scope.project,
    ],
    {
      env: {
        ...process.env,
        MEMORY_LAB_DIR: f.dir,
        MEMORY_LAB_OWNER: scope.owner,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(explicit.status, 1);
  assert.deepEqual(JSON.parse(explicit.stdout), { status: "invalid-input" });
  for (const bad of [
    "synthetic-secret",
    Buffer.alloc(96 * 1024 + 1),
    JSON.stringify({ ...draft, scopeKey: "b".repeat(64) }),
    JSON.stringify({
      ...draft,
      candidates: Array(5).fill(draft.candidates[0]),
    }),
    JSON.stringify({ ...draft, draftFile: "../elsewhere.txt" }),
  ]) {
    await fs.writeFile(f.latest, bad);
    assert.deepEqual(f.list().output, { status: "invalid-draft" });
  }
  await f.publish(draft);
  await fs.chmod(f.latest, 0o644);
  assert.deepEqual(f.list().output, { status: "invalid-draft" });
  await fs.rename(f.latest, join(f.folder, "elsewhere"));
  await fs.symlink(join(f.folder, "elsewhere"), f.latest);
  assert.deepEqual(f.list().output, { status: "invalid-draft" });
  await fs.rename(f.folder, join(f.dir, "other-folder"));
  await fs.symlink(join(f.dir, "other-folder"), f.folder);
  assert.deepEqual(f.list().output, { status: "invalid-draft" });
});
