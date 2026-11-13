"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readCodex, readDsh } = require("../lib/adapters");
const { openArchive } = require("../lib/archive.cjs");
const { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");
const {
  originalCapture,
  readVerifiedOriginal,
} = require("../lib/originals.cjs");
const { runLocalDerive } = require("../lib/local-derive.cjs");

const scope = { owner: "synthetic", project: "native-turns" };
const timestamp = "2026-01-02T00:00:00Z";
const codexRecord = (type, payload) => ({ timestamp, type, payload });
const codex = ({ abort = false, repeated = false } = {}) => [
  codexRecord("session_meta", { id: "synthetic-session" }),
  codexRecord("event_msg", { type: "task_started", turn_id: "turn-one" }),
  codexRecord("turn_context", { turn_id: "turn-one" }),
  codexRecord("response_item", {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "Next step: prepare the blue release notes.",
      },
    ],
  }),
  codexRecord("response_item", {
    type: "message",
    role: "user",
    source: { kind: "plugin", plugin: "synthetic" },
    content: [
      {
        type: "input_text",
        text: "Decide to write back injected Codex plugin memory.",
      },
    ],
  }),
  codexRecord("response_item", {
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [
      {
        type: "output_text",
        text: "Next step: injected commentary must be excluded.",
      },
    ],
  }),
  codexRecord("response_item", {
    type: "message",
    role: "assistant",
    phase: "final_answer",
    content: [
      { type: "output_text", text: "I will prepare the blue release notes." },
    ],
  }),
  ...(abort
    ? [
        codexRecord("event_msg", {
          type: "turn_aborted",
          turn_id: "turn-one",
          reason: "interrupted",
        }),
      ]
    : []),
  codexRecord("event_msg", { type: "task_complete", turn_id: "turn-one" }),
  ...(repeated
    ? [codexRecord("event_msg", { type: "task_complete", turn_id: "turn-one" })]
    : []),
];
const dsh = ({
  interrupted = false,
  injection = true,
  repeated = false,
} = {}) => {
  const records = [
    {
      type: "session",
      version: 4,
      createdAt: 1,
      cwd: "/synthetic",
      delegationDepth: 0,
      id: "synthetic-session",
      isSeeded: false,
    },
  ];
  const add = (type, data, extra = {}) =>
    records.push({
      type,
      seq: records.length,
      time: timestamp,
      data,
      ...extra,
    });
  add("turn/start", { turn: 1 });
  add(
    "user/message",
    {
      turn: 1,
      id: "user-1",
      role: "user",
      content: [
        { type: "text", text: "Next step: prepare the green release notes." },
      ],
      source: { kind: "user" },
    },
    { surfaceOp: "append" },
  );
  if (injection)
    add(
      "user/message",
      {
        turn: 1,
        id: "plugin-1",
        role: "user",
        content: [
          {
            type: "text",
            text: "Decide to write back this injected plugin memory.",
          },
        ],
        source: { kind: "plugin", plugin: "synthetic", form: "recall" },
      },
      { surfaceOp: "append" },
    );
  add(
    "assistant/message",
    {
      turn: 1,
      message: {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "I will prepare the green release notes." },
        ],
        source: { kind: "model", provider: "synthetic", model: "synthetic" },
      },
    },
    { surfaceOp: "append" },
  );
  add("turn/end", {
    turn: 1,
    reason: { kind: interrupted ? "interrupted" : "completed" },
  });
  if (repeated) add("turn/end", { turn: 1, reason: { kind: "completed" } });
  return records;
};

async function setup(t, harness, records, initialCount = records.length) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-writer-e2e-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "source.jsonl");
  const lines = records.map((record) =>
    Buffer.from(JSON.stringify(record) + "\n"),
  );
  await fs.writeFile(file, Buffer.concat(lines.slice(0, initialCount)));
  const reader = harness === "codex" ? readCodex : readDsh;
  const opts = {
    ...scope,
    file,
    instance: "synthetic",
    session: "synthetic-session",
    captureOriginal: originalCapture(dir),
    lookback: 0,
  };
  let checkpoint;
  const captured = [];
  const batches = [];
  async function ingest() {
    const archive = await openArchive({ dir });
    try {
      for await (const batch of reader({
        ...opts,
        ...(checkpoint ? { checkpoint } : {}),
      })) {
        batches.push(batch);
        for (const item of batch.items) captured.push(item);
        await archive.importBatch(batch);
        checkpoint = {
          position: batch.checkpoint.position,
          source: batch.source,
        };
      }
    } finally {
      archive.close?.();
    }
  }
  await ingest();
  return {
    dir,
    file,
    lines,
    captured,
    ingest,
    async replay() {
      const archive = await openArchive({ dir });
      try {
        const before = await archive.listItems(scope);
        for (const batch of batches)
          assert.equal((await archive.importBatch(batch)).replayed, true);
        const after = await archive.listItems(scope);
        assert.deepEqual(
          after.map((row) => row.versionId).sort(),
          before.map((row) => row.versionId).sort(),
        );
      } finally {
        archive.close?.();
      }
    },
    get checkpoint() {
      return checkpoint;
    },
  };
}
async function derive(dir, allowOriginalRetry = false) {
  const prompts = [];
  const runner = {
    async prepareLocalModel() {
      return { fingerprint: "synthetic-stub" };
    },
    async runLocalLlama({ prompt }) {
      prompts.push(JSON.parse(prompt.split("\n").at(-1)));
      return { output: JSON.stringify({ candidates: [] }), stats: {} };
    },
  };
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = await runLocalDerive({ dir, ...scope }, runner);
    if (prompts.length) break;
    if (result.status === "retryable") {
      assert.ok(
        allowOriginalRetry && result.reason === "ORIGINAL_UNAVAILABLE",
        "unexpected retryable result",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return prompts;
}
async function assertOriginals(fixture) {
  for (const item of fixture.captured) {
    const original = await readVerifiedOriginal(
      fixture.dir,
      item.metadata.original,
    );
    assert.equal(original.status, "verified");
    assert.deepEqual(
      original.bytes,
      fixture.lines[item.metadata.coordinate - 1],
    );
  }
}

for (const [harness, records, expected] of [
  [
    "codex",
    codex({ repeated: true }),
    "Next step: prepare the blue release notes.",
  ],
  [
    "dsh",
    dsh({ repeated: true }),
    "Next step: prepare the green release notes.",
  ],
]) {
  test(`${harness} native completed turn reaches Writer after checkpoint restart, preserving originals`, async (t) => {
    const fixture = await setup(t, harness, records, records.length - 2);
    await fs.appendFile(
      fixture.file,
      Buffer.concat(fixture.lines.slice(records.length - 2)),
    );
    await fixture.ingest();
    assert.equal(fixture.checkpoint.position, records.length);
    await assertOriginals(fixture);
    await fixture.replay();
    await migrateJsonToSqlite({ dir: fixture.dir });
    const prompts = await derive(fixture.dir);
    assert.equal(prompts.length, 1);
    assert(prompts[0].some((row) => row.text.includes(expected)));
    assert(!JSON.stringify(prompts).includes("injected plugin memory"));
    assert(!JSON.stringify(prompts).includes("injected Codex plugin memory"));
    assert(!JSON.stringify(prompts).includes("injected commentary"));
    assert.equal((await derive(fixture.dir)).length, 0);
    await assertOriginals(fixture);
  });
}

test("a Writer restart reconsiders a turn when completion arrives after the first scan", async (t) => {
  const records = dsh();
  const fixture = await setup(t, "dsh", records, records.length - 1);
  await migrateJsonToSqlite({ dir: fixture.dir });
  assert.deepEqual(await derive(fixture.dir), []);
  await fs.appendFile(fixture.file, fixture.lines.at(-1));
  await fixture.ingest();
  const prompts = await derive(fixture.dir);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].length, 2);
  assert.ok(!JSON.stringify(prompts).includes("injected plugin memory"));
  assert.deepEqual(await derive(fixture.dir), []);
  await assertOriginals(fixture);
});

test("a missing native boundary original is deferred and retried after restoration", async (t) => {
  const fixture = await setup(t, "codex", codex());
  await migrateJsonToSqlite({ dir: fixture.dir });
  const start = fixture.captured.find(
    (item) => item.metadata.recordType === "event_msg:task_started",
  );
  const original = path.join(
    fixture.dir,
    "originals",
    `${start.metadata.original.sha256}.jsonl`,
  );
  const bytes = await fs.readFile(original);
  await fs.unlink(original);
  const result = await runLocalDerive(
    { dir: fixture.dir, ...scope },
    {
      async prepareLocalModel() {
        assert.fail("unverified turn reached the runner");
      },
    },
  );
  assert.equal(result.reason, "ORIGINAL_UNAVAILABLE");
  assert.equal(result.modelCalls, 0);
  await fs.writeFile(original, bytes, { mode: 0o600 });
  assert.equal((await derive(fixture.dir, true)).length, 1);
  await assertOriginals(fixture);
});
for (const [harness, records] of [
  ["codex", codex({ abort: true })],
  ["dsh", dsh({ interrupted: true, repeated: true })],
]) {
  test(`${harness} interrupted turn never reaches Writer even with completion marker`, async (t) => {
    const fixture = await setup(t, harness, records);
    await assertOriginals(fixture);
    await migrateJsonToSqlite({ dir: fixture.dir });
    assert.deepEqual(await derive(fixture.dir), []);
  });
}

test("DSH sequence gap prevents Writer selection while preserving originals", async (t) => {
  const records = dsh();
  for (let index = 3; index < records.length; index++) records[index].seq++;
  const fixture = await setup(t, "dsh", records);
  assert(
    fixture.checkpoint.source.coverage.gaps.some(
      (gap) => gap.reason === "source-sequence-gap",
    ),
  );
  await assertOriginals(fixture);
  await migrateJsonToSqlite({ dir: fixture.dir });
  assert.deepEqual(await derive(fixture.dir), []);
  await assertOriginals(fixture);
});
