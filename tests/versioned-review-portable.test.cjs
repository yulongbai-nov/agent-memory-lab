"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const repo = resolve(
  process.env.VERSIONED_REVIEW_REPO || join(__dirname, ".."),
);
const { openArchive } = require(join(repo, "lib/archive.cjs"));
const execute = promisify(execFile);
const scope = { owner: "fixture-operator", project: "portable-review" };
const date = "2026-04-08T10:00:00.000Z";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function cli(dir, args, { reject = false, wire } = {}) {
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8" };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (wire) {
    env.NODE_OPTIONS = `--require="${join(repo, "tests/task-state-couch-wire.cjs")}"`;
    env.TASK_STATE_WIRE_STORE = wire;
  }
  const command = [
    join(repo, "bin/memory.cjs"),
    ...args,
    "--dir",
    dir,
    "--owner",
    scope.owner,
    "--project",
    scope.project,
  ];
  let result;
  try {
    result = await execute(process.execPath, command, {
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  } catch (error) {
    if (!reject || !Number.isInteger(error.code)) throw error;
    assert.equal(error.stdout, "");
    return null;
  }
  assert.equal(reject, false, `expected rejection for ${args[0]}`);
  return JSON.parse(result.stdout);
}

async function ingest(dir, session, messages) {
  const file = join(dir, `${session}.jsonl`);
  const rows = [
    {
      type: "session",
      version: 4,
      id: session,
      createdAt: Date.parse(date),
      cwd: "/synthetic",
      isSeeded: false,
      delegationDepth: 0,
    },
    ...messages.map(([id, text], index) => ({
      type: "user/message",
      seq: index + 1,
      time: date,
      data: { id, role: "user", text },
    })),
  ];
  await fs.writeFile(
    file,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    { mode: 0o600 },
  );
  const result = await cli(dir, [
    "ingest",
    "--source",
    "dsh",
    "--file",
    file,
    "--instance",
    "synthetic",
    "--session",
    session,
  ]);
  assert.equal(result.itemsImported, rows.length);
}

async function readArchive(dir, read) {
  const archive = await openArchive({ dir, readOnly: true });
  try {
    return await read(archive);
  } finally {
    archive.close?.();
  }
}

function quote(row, start, end, kind) {
  const { item, source, versionId } = row;
  const ref = {
    source: [source.harness, source.instance, source.session].join("/"),
    item: item.id,
    version: versionId,
  };
  const span = {
    kind,
    fieldPath: "data.text",
    originalSha256: item.metadata.original.sha256,
    startUtf16: start,
    endUtf16: end,
    startUtf8: Buffer.byteLength(item.text.slice(0, start)),
    endUtf8: Buffer.byteLength(item.text.slice(0, end)),
    previewStartUtf16: start,
    previewEndUtf16: end,
  };
  return {
    projection: { ...ref, ...span },
    evidence: {
      ...ref,
      quote: item.text.slice(start, end),
      originalSpan: span,
    },
  };
}

async function receipt(dir, name, candidates, inputProjections) {
  const bytes = Buffer.from(
    JSON.stringify({
      formatVersion: 2,
      scope,
      producer: {
        writerProtocol: "fixture-writer",
        recipeIdentity: sha(name),
        outputProtocol: "candidate-v2",
      },
      generatedAt: date,
      candidates,
      inputProjections,
    }),
  );
  const file = join(dir, `${name}.json`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return (expected) => [
    "draft-publish",
    "--receipt",
    file,
    "--receipt-sha256",
    sha(bytes),
    "--expect-latest",
    expected,
  ];
}

test("real CLI preserves three declared spans across publication CAS and capsule sync", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "portable-review-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const origin = join(root, "origin"),
    peer = join(root, "peer"),
    wire = join(root, "wire");
  await Promise.all(
    [origin, peer, wire].map((dir) => fs.mkdir(dir, { mode: 0o700 })),
  );
  const text =
    "先看绿色版。🙂入口样品已登记。后来仍说先看绿色版。盲文卡尚未校对。";
  const support = "周五清单确认最终选用绿色版。";
  await ingest(origin, "main", [
    ["record", text],
    ["record", "后来更新原记录。"],
  ]);
  await ingest(origin, "support", [["support", support]]);
  await ingest(peer, "peer-local", [
    ["local", "Unrelated synthetic peer record."],
  ]);
  await Promise.all([origin, peer].map((dir) => cli(dir, ["migrate-index"])));
  const rows = await readArchive(origin, (archive) => archive.listItems(scope));
  const old = rows.find((row) => row.item.text === text),
    other = rows.find((row) => row.item.text === support);
  assert.ok(old && other);
  const registration = "入口样品已登记。",
    repeated = "先看绿色版。";
  const start = text.indexOf(registration),
    later = text.lastIndexOf(repeated);
  assert.ok(later > text.indexOf(repeated));
  const spans = [
    quote(old, start, start + registration.length, "fragment"),
    quote(old, later, later + repeated.length, "fragment"),
    quote(other, 0, support.length, "full"),
  ];
  const evidence = spans.map((item) => item.evidence);
  const candidate = {
    kind: "decision",
    basis: "confirmed",
    claim: "入口样品已登记并选用绿色版。",
    evidence,
  };
  const unfinished = "盲文卡尚未校对。",
    taskStart = text.indexOf(unfinished);
  const taskSpan = quote(
    old,
    taskStart,
    taskStart + unfinished.length,
    "fragment",
  );
  const task = {
    kind: "todo",
    claim: "校对盲文卡。",
    evidence: [taskSpan.evidence],
  };
  const make = await receipt(
    origin,
    "three-spans",
    [candidate, task],
    [...spans, taskSpan].map((item) => item.projection),
  );
  const first = await cli(origin, make("none"));
  const id = `${first.snapshot}:1`;
  const taskId = `${first.snapshot}:2`;
  const left = await receipt(origin, "left", [], []),
    right = await receipt(origin, "right", [], []);
  const outcomes = await Promise.allSettled([
    cli(origin, left(first.snapshot)),
    cli(origin, right(first.snapshot)),
  ]);
  assert.equal(
    outcomes.filter((item) => item.status === "fulfilled").length,
    1,
  );
  const winner = outcomes.find((item) => item.status === "fulfilled").value
    .snapshot;
  const latest = await cli(origin, ["draft-list", "--format", "v2"]);
  assert.deepEqual([latest.snapshot, latest.status], [winner, "empty"]);
  await cli(origin, make(first.snapshot), { reject: true });
  const detail = (
    await cli(origin, ["draft-show", "--format", "v2", "--id", id])
  ).candidate;
  assert.deepEqual(
    detail.evidence.map((item) => item.originalSpan),
    evidence.map((item) => item.originalSpan),
  );
  assert.deepEqual(
    detail.evidence.map((item) => item.sourceStatus),
    ["older-version", "older-version", "current"],
  );
  assert.ok(
    detail.evidence.every((item) => item.quoteStatus === "verified-original"),
  );

  const review = [
    "draft-review",
    "--id",
    id,
    "--text",
    "已复核绿色版决定。",
    "--topic",
    "Synthetic labels",
    "--basis",
    "confirmed",
  ];
  await cli(origin, review, { reject: true });
  const [reviewed, replayed] = await Promise.all([
    cli(origin, [...review, "--primary", "3"]),
    cli(origin, [...review, "--primary", "3"]),
  ]);
  assert.deepEqual(replayed, reviewed);
  const [annotation] = await readArchive(origin, (archive) =>
    archive.listAnnotations(scope),
  );
  assert.equal(reviewed.id, annotation.id);
  assert.equal(annotation.target.revision, evidence[2].version);
  assert.equal(annotation.candidateReview.primary, 3);
  assert.deepEqual(annotation.candidateReview.candidate.evidence, evidence);
  const taskReview = await cli(origin, [
    "draft-review",
    "--id",
    taskId,
    "--text",
    "校对盲文卡。",
    "--topic",
    "Synthetic labels",
  ]);
  const pending = (await cli(origin, ["task-list"])).tasks.find(
    (item) => item.root.id === taskReview.id,
  );
  assert.equal(pending.candidateLineage.candidateId, taskId);
  await cli(origin, [
    "annotate",
    "--id",
    "fixture-close-task",
    "--kind",
    "task-state",
    "--task-root",
    JSON.stringify(pending.root),
    "--target",
    JSON.stringify(pending.target),
    "--parents",
    "[]",
    "--state",
    "completed",
    "--evidence-kind",
    "operator",
    "--text",
    "已校对盲文卡。",
  ]);
  assert.deepEqual((await cli(origin, ["task-list"])).tasks, []);

  const sync = (dir, mode) =>
    cli(
      dir,
      [
        "sync",
        "--couch-url",
        "http://127.0.0.1:5984/task-state-test",
        "--sync-mode",
        mode,
      ],
      { wire },
    );
  assert.ok((await sync(origin, "all")).pushed > 0);
  assert.ok((await sync(peer, "pull")).pulled > 0);
  assert.equal((await sync(peer, "pull")).pulled, 0);
  const ledger = async (dir) =>
    (await readArchive(dir, (archive) => archive.listAnnotations(scope))).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
  assert.deepEqual(await ledger(peer), await ledger(origin));
  const received = await cli(peer, [
    "draft-review-show",
    "--review-id",
    reviewed.id,
  ]);
  assert.equal(received.snapshotStatus, "missing");
  assert.equal(received.review.reviewedAt, reviewed.reviewedAt);
  assert.equal(received.candidate.id, id);
  assert.deepEqual(
    received.candidate.evidence.map((item) => item.quote),
    evidence.map((item) => item.quote),
  );
  assert.ok(
    received.candidate.evidence.every(
      (item) =>
        item.quoteStatus === "archived-preview-only" &&
        !("originalSpan" in item),
    ),
  );
  assert.deepEqual((await cli(peer, ["task-list"])).tasks, []);
  const history = (
    await cli(peer, ["timeline", "--topic", "Synthetic labels"])
  ).rows.find((item) => item.review_id === taskReview.id);
  assert.equal(history.task_state.state, "completed");
  assert.equal(history.candidateLineage.candidateId, taskId);
});
