"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { openArchive } = require("../lib/archive.cjs");
const { dailyReview } = require("../lib/daily.cjs");
const { runLocalDerive } = require("../lib/local-derive.cjs");
const { operations } = require("../lib/operations.cjs");
const originals = require("../lib/originals.cjs");
const { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");

const scope = { owner: "synthetic", project: "recovery" };
const otherScope = { owner: "synthetic", project: "other" };
const source = { harness: "dsh", instance: "fixture", session: "one" };
const oldTime = "2025-01-01T00:00:00Z";
const newTime = "2026-01-01T00:00:00Z";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "local-derive-recovery-"));
  let archive = await openArchive({ dir });
  t.after(async () => {
    archive.close?.();
    await rm(dir, { recursive: true, force: true });
  });
  const capture = originals.originalCapture(dir);
  const positions = new Map();
  let coordinate = 0;
  return {
    dir,
    async message(id, turnId, text, time, role = "user") {
      const position = ++coordinate;
      const recordType = role + "/message";
      const original = await capture({
        coordinate: position,
        bytes: Buffer.from(
          JSON.stringify({
            type: recordType,
            data: { role, text },
          }) + "\n",
        ),
      });
      return {
        id,
        kind: "message",
        role,
        turnId,
        text,
        time,
        metadata: { recordType, coordinate: position, original },
      };
    },
    terminal(turnId, time, status = "completed") {
      return {
        id: "end-" + turnId + "-" + status,
        kind: "event",
        status,
        turnId,
        time,
        metadata: { recordType: "turn/end", coordinate: ++coordinate },
      };
    },
    async append(items, selectedScope = scope) {
      const previous = positions.get(selectedScope.project);
      const position = (previous ?? 0) + items.length;
      await archive.importBatch({
        scope: selectedScope,
        source,
        checkpoint: { ...(previous !== undefined && { previous }), position },
        items,
      });
      positions.set(selectedScope.project, position);
    },
    async migrate() {
      archive.close?.();
      await migrateJsonToSqlite({ dir });
      archive = await openArchive({ dir });
    },
    item(id) {
      return archive.getItem({ ...scope, source, id });
    },
    async drafts() {
      const folder = join(dir, "local-derive");
      const names = (await readdir(folder)).filter((name) =>
        name.endsWith(".txt"),
      );
      return Promise.all(
        names.map((name) => readFile(join(folder, name), "utf8")),
      );
    },
    async assertNoReviewWrites() {
      assert.deepEqual(await archive.listAnnotations(scope), []);
      assert.deepEqual(await archive.listAnnotations(otherScope), []);
    },
  };
}

function syntheticRunner(makeCandidates) {
  const prompts = [];
  return {
    prompts,
    async prepareLocalModel() {
      return { fingerprint: "synthetic-recovery-stub" };
    },
    async runLocalLlama({ prompt }) {
      const inputs = JSON.parse(prompt.split("\n").at(-1));
      prompts.push(inputs);
      return {
        output: JSON.stringify({ candidates: await makeCandidates(inputs) }),
        stats: {},
      };
    },
  };
}

function oneCandidate([{ source, item, version, text }]) {
  return [
    {
      kind: "todo",
      claim: "Review the synthetic checklist.",
      evidence: [{ source, item, version, quote: text }],
    },
  ];
}

function hasExactQuote(draft, text) {
  const prefix = "引文 ";
  return draft
    .split("\n")
    .some(
      (line) =>
        line.trimStart().startsWith(prefix) &&
        JSON.parse(line.trimStart().slice(prefix.length)) === text,
    );
}

async function drainUntil(options, runner, done, runs) {
  for (let pass = 0; pass < runs && !done(); pass++) {
    await runLocalDerive(options, runner);
  }
  assert.ok(
    done(),
    "Eligible synthetic work did not complete within the bound",
  );
}

async function runUntilAttempt(options, runner) {
  const priorAttempts = runner.prompts.length;
  for (let pass = 0; pass < 4; pass++) {
    const result = await runLocalDerive(options, runner);
    if (runner.prompts.length > priorAttempts) return result;
    assert.equal(result.modelCalls, 0);
  }
  assert.fail(
    "Eligible synthetic work did not reach the stub within four runs",
  );
}

test("draft recovery retries the same exact batch after newer filtered turns arrive", async (t) => {
  const f = await fixture(t);
  const text = "Next step: prepare the synthetic amber checklist.";
  await f.append([
    await f.message("old", "old", text, oldTime),
    f.terminal("old", oldTime),
  ]);
  await f.migrate();
  const original = await f.item("old");

  let clock = Date.parse("2026-01-01T01:00:00Z");
  t.mock.method(Date, "now", () => clock);
  let unavailable = true;
  const runner = syntheticRunner((inputs) => {
    if (unavailable)
      throw Object.assign(new Error("Synthetic resource admission failure"), {
        code: "MEMORY_ADMISSION",
        safeLocal: true,
      });
    return oneCandidate(inputs);
  });
  const options = { dir: f.dir, ...scope };
  const failed = await runUntilAttempt(options, runner);
  assert.equal(failed.status, "retryable");
  assert.equal(failed.reason, "MEMORY_ADMISSION");
  assert.equal(failed.modelCalls, 0);
  assert.deepEqual(
    runner.prompts[0].map((item) => item.text),
    [text],
  );

  const noise = [];
  for (let i = 0; i < 20; i++) {
    const turn = "noise-" + i;
    noise.push(
      await f.message(turn, turn, "Thank you!", newTime),
      f.terminal(turn, newTime),
    );
  }
  await f.append(noise);
  unavailable = false;
  clock += 7 * 24 * 60 * 60 * 1000;
  const recovered = await runUntilAttempt(options, runner);
  assert.equal(recovered.status, "validated");
  assert.equal(recovered.exactReferences, 1);
  assert.deepEqual(runner.prompts, [runner.prompts[0], runner.prompts[0]]);
  const drafts = await f.drafts();
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].includes(original.versionId));
  assert.ok(hasExactQuote(drafts[0], text));
  assert.equal((await f.item("old")).versionId, original.versionId);
  await f.assertNoReviewWrites();
});

test("a crash after validated cache persistence resumes without another model call", async (t) => {
  const f = await fixture(t);
  const text = "Next step: prepare the synthetic crash checklist.";
  await f.append([
    await f.message("crash", "crash", text, oldTime),
    f.terminal("crash", oldTime),
  ]);
  await f.migrate();
  const original = await f.item("crash");
  const options = { dir: f.dir, ...scope };
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
        const fs = require("node:fs/promises");
        const { basename } = require("node:path");
        const rename = fs.rename;
        fs.rename = async (from, to) => {
          if (/^draft-.*[.]txt$/.test(basename(to))) process.exit(73);
          return rename(from, to);
        };
        const { runLocalDerive } = require(process.argv[1]);
        const options = JSON.parse(process.argv[2]);
        runLocalDerive(options, {
          async prepareLocalModel() {
            return { fingerprint: "synthetic-recovery-stub" };
          },
          async runLocalLlama({ prompt }) {
            const [{ source, item, version, text }] = JSON.parse(prompt.split("\\n").at(-1));
            const evidence = [{ source, item, version, quote: text }];
            return {
              output: JSON.stringify({
                candidates: [{ kind: "todo", claim: "Review the synthetic checklist.", evidence }]
              }),
              stats: {},
            };
          },
        }).catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `,
      require.resolve("../lib/local-derive.cjs"),
      JSON.stringify(options),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 73, String(child.error ?? child.stderr));
  assert.deepEqual(await f.drafts(), []);

  const runner = syntheticRunner(oneCandidate);
  let preparations = 0;
  runner.prepareLocalModel = async () => {
    preparations++;
    return { fingerprint: "synthetic-different-model" };
  };
  const cacheDir = join(f.dir, "local-derive");
  const cacheNames = (await readdir(cacheDir)).filter((name) =>
    /^[a-f0-9]{64}[.]json$/.test(name),
  );
  assert.equal(cacheNames.length, 1);
  const cache = join(cacheDir, cacheNames[0]);
  const validCache = await readFile(cache);
  await writeFile(cache, "null");
  const corrupt = await runLocalDerive(options, runner);
  assert.equal(corrupt.status, "retryable");
  assert.equal(corrupt.modelCalls, 0);
  assert.equal(preparations, 0);
  assert.deepEqual(runner.prompts, []);
  assert.deepEqual(await f.drafts(), []);
  assert.equal(await readFile(cache, "utf8"), "null");
  await writeFile(cache, validCache);
  const recovered = await runLocalDerive(options, runner);
  assert.equal(recovered.status, "validated");
  assert.equal(recovered.cacheHit, true);
  assert.equal(recovered.modelCalls, 0);
  assert.equal(recovered.exactReferences, 1);
  assert.equal(preparations, 0);
  assert.deepEqual(runner.prompts, []);
  const drafts = await f.drafts();
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].includes(original.versionId));
  assert.ok(hasExactQuote(drafts[0], text));
  assert.equal((await runLocalDerive(options, runner)).modelCalls, 0);
  await f.assertNoReviewWrites();
});

test("rebuilding the sidecar reuses the exact validated cache and preserves the draft", async (t) => {
  const f = await fixture(t);
  const quote = "Next step: prepare the synthetic sidecar rebuild checklist.";
  await f.append([
    await f.message("rebuild", "rebuild", quote, oldTime),
    f.terminal("rebuild", oldTime),
  ]);
  await f.migrate();
  const { versionId } = await f.item("rebuild");
  const runner = syntheticRunner(oneCandidate);
  const options = { dir: f.dir, ...scope };
  const original = await runUntilAttempt(options, runner);
  assert.equal(original.status, "validated");
  assert.equal(original.cacheHit, false);
  assert.equal(original.exactReferences, 1);

  const folder = join(f.dir, "local-derive");
  const files = await readdir(folder);
  const queues = files.filter((name) => /^queue-.*[.]sqlite$/.test(name));
  const drafts = files.filter((name) => /^draft-.*[.]txt$/.test(name));
  const caches = files.filter((name) => /^[a-f0-9]{64}[.]json$/.test(name));
  assert.equal(queues.length, 1);
  assert.equal(drafts.length, 1);
  assert.equal(caches.length, 1);
  const queuePath = join(folder, queues[0]);
  const draftPath = join(folder, drafts[0]);
  const cachePath = join(folder, caches[0]);
  const before = await stat(draftPath);
  const draft = await readFile(draftPath, "utf8");
  const cache = await readFile(cachePath);
  await rm(queuePath);

  const rebuilt = await runLocalDerive(options, runner);
  assert.equal(rebuilt.status, "validated");
  assert.equal(rebuilt.cacheHit, true);
  assert.equal(rebuilt.modelCalls, 0);
  assert.equal(rebuilt.exactReferences, 1);
  assert.equal(runner.prompts.length, 1);
  assert.ok((await stat(queuePath)).isFile());
  const after = await stat(draftPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(draftPath, "utf8"), draft);
  assert.deepEqual(await readFile(cachePath), cache);
  assert.deepEqual(await f.drafts(), [draft]);
  assert.ok(draft.includes(versionId));
  assert.ok(hasExactQuote(draft, quote));
  await f.assertNoReviewWrites();
});

test(
  "same-scope concurrent derives call once while the archive can still append",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const text = "Next step: prepare the synthetic concurrent checklist.";
    await f.append([
      await f.message("eligible", "eligible", text, oldTime),
      f.terminal("eligible", oldTime),
    ]);
    await f.migrate();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const runner = syntheticRunner(async (inputs) => {
      started.resolve();
      await release.promise;
      return oneCandidate(inputs);
    });
    const options = { dir: f.dir, ...scope };
    const first = runLocalDerive(options, runner);
    await Promise.race([
      started.promise,
      first.then(() => assert.fail("The model stub was never reached")),
    ]);
    const competing = runLocalDerive(options, runner);
    try {
      const later = await f.message(
        "later",
        "unfinished",
        "Thank you!",
        newTime,
      );
      await f.append([later]);
      assert.equal((await f.item(later.id)).item.text, later.text);
    } finally {
      release.resolve();
      await Promise.allSettled([first, competing]);
    }
    const outcomes = await Promise.all([first, competing]);
    assert.equal(
      outcomes.reduce((sum, row) => sum + row.modelCalls, 0),
      1,
    );
    assert.equal(runner.prompts.length, 1);
    const drafts = await f.drafts();
    assert.equal(drafts.length, 1);
    assert.ok(hasExactQuote(drafts[0], text));
    await f.assertNoReviewWrites();
  },
);

test("a repeatedly invalid batch does not starve a later eligible turn", async (t) => {
  const f = await fixture(t);
  const bad = "Next step: prepare the synthetic invalid-output checklist.";
  const good = "Next step: prepare the synthetic eligible-later checklist.";
  await f.append([
    await f.message("bad", "bad", bad, oldTime),
    f.terminal("bad", oldTime),
  ]);
  await f.migrate();
  let clock = Date.parse("2026-01-02T00:00:00Z");
  t.mock.method(Date, "now", () => clock);
  const runner = syntheticRunner((inputs) =>
    inputs.some(({ text }) => text === bad)
      ? [{ kind: "todo", claim: "Malformed candidate.", evidence: [] }]
      : oneCandidate(inputs),
  );
  const options = { dir: f.dir, ...scope };
  assert.equal((await runUntilAttempt(options, runner)).status, "retryable");
  await f.append([
    await f.message("good", "good", good, newTime),
    f.terminal("good", newTime),
  ]);
  const goodVersion = await f.item("good");
  for (let pass = 0; pass < 8; pass++) {
    clock += 24 * 60 * 60 * 1000;
    const result = await runLocalDerive(options, runner);
    if (result.status === "validated") break;
  }
  assert.ok(
    runner.prompts.filter((inputs) => inputs.some(({ text }) => text === bad))
      .length >= 2,
  );
  const drafts = await f.drafts();
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].includes(goodVersion.versionId));
  assert.ok(hasExactQuote(drafts[0], good));
  assert.ok(!hasExactQuote(drafts[0], bad));
  await f.assertNoReviewWrites();
});

test("a higher-ranked peer cannot consume an earlier user excluded by the batch budget", async (t) => {
  const f = await fixture(t);
  const first =
    "The synthetic amber checklist " +
    "covers each local item ".repeat(15).trim();
  const second =
    "We decided to revise the next step and " +
    "prepare each blue item ".repeat(15).trim();
  await f.append([
    await f.message("first", "budget", first, oldTime),
    await f.message("second", "budget", second, oldTime),
    f.terminal("budget", oldTime),
  ]);
  await f.migrate();
  const runner = syntheticRunner(oneCandidate);
  await drainUntil(
    { dir: f.dir, ...scope },
    runner,
    () => runner.prompts.length === 2,
    6,
  );
  assert.deepEqual(
    new Set(runner.prompts.map((inputs) => inputs[0].text)),
    new Set([first, second]),
  );
  assert.ok(runner.prompts.every((inputs) => inputs.length === 1));
  const drafts = await f.drafts();
  for (const [id, text] of [
    ["first", first],
    ["second", second],
  ]) {
    const { versionId } = await f.item(id);
    assert.ok(
      drafts.some(
        (draft) => draft.includes(versionId) && hasExactQuote(draft, text),
      ),
    );
  }
  await f.assertNoReviewWrites();
});

test("five user messages in one turn leave room for later eligible work", async (t) => {
  const f = await fixture(t);
  const users = Array.from(
    { length: 5 },
    (_, i) => "Next step: prepare the sample checklist " + i + ".",
  );
  const later = "We decided to update a separate later checklist.";
  await f.append([
    ...(await Promise.all(
      users.map((text, i) => f.message("user-" + i, "many", text, oldTime)),
    )),
    f.terminal("many", oldTime),
    await f.message("later", "later", later, newTime),
    f.terminal("later", newTime),
  ]);
  await f.migrate();
  const runner = syntheticRunner(() => []);
  const seen = () =>
    new Set(
      runner.prompts.flatMap((inputs) => inputs.map((input) => input.text)),
    );
  await drainUntil(
    { dir: f.dir, ...scope },
    runner,
    () => seen().has(later),
    10,
  );
  assert.deepEqual(seen(), new Set([...users, later]));
  await f.assertNoReviewWrites();
});

test("deferring an unavailable peer leaves the preceding eligible user at its cursor", async (t) => {
  const f = await fixture(t);
  const anchor = await f.message(
    "anchor",
    "peer",
    "Next step: prepare the anchor checklist.",
    oldTime,
  );
  const peer = await f.message(
    "missing",
    "peer",
    "Next step: prepare the peer checklist.",
    oldTime,
  );
  await rm(join(f.dir, "originals", peer.metadata.original.sha256 + ".jsonl"));
  await f.append([anchor, peer, f.terminal("peer", oldTime)]);
  await f.migrate();
  const runner = syntheticRunner(oneCandidate);
  const result = await runUntilAttempt({ dir: f.dir, ...scope }, runner);
  assert.equal(result.status, "validated");
  assert.equal(result.exactReferences, 1);
  assert.deepEqual(
    runner.prompts[0].map(({ text }) => text),
    [anchor.text],
  );
  const drafts = await f.drafts();
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].includes((await f.item(anchor.id)).versionId));
  assert.ok(hasExactQuote(drafts[0], anchor.text));
  await f.assertNoReviewWrites();
});

test("each eligible user in a long turn retains its assistant page continuation", async (t) => {
  const f = await fixture(t);
  const users = [
    "Next step: prepare the amber checklist.",
    "We decided to update the blue checklist.",
  ];
  const assistants = [
    "Amber has two sample entries.",
    "Blue has three sample entries.",
    "Green has four sample entries.",
  ];
  await f.append([
    ...(await Promise.all(
      users.map((text, i) => f.message("user-" + i, "long", text, oldTime)),
    )),
    ...(await Promise.all(
      assistants.map((text, i) =>
        f.message("assistant-" + i, "long", text, oldTime, "assistant"),
      ),
    )),
    f.terminal("long", oldTime),
  ]);
  await f.migrate();
  const runner = syntheticRunner(oneCandidate);
  const pairs = new Set();
  function allPairs() {
    for (const inputs of runner.prompts) {
      const texts = inputs.map((input) => input.text);
      for (const user of users) {
        for (const assistant of assistants) {
          if (texts.includes(user) && texts.includes(assistant))
            pairs.add(user + assistant);
        }
      }
    }
    return pairs.size === users.length * assistants.length;
  }
  await drainUntil({ dir: f.dir, ...scope }, runner, allPairs, 12);
  const drafts = await f.drafts();
  for (const [i, user] of users.entries()) {
    const { versionId } = await f.item("user-" + i);
    assert.ok(
      drafts.some(
        (draft) => draft.includes(versionId) && hasExactQuote(draft, user),
      ),
    );
  }
  await f.assertNoReviewWrites();
});

test("individually verifiable context that cannot fit together remains held with an explicit reason", async (t) => {
  const f = await fixture(t);
  const user =
    "Next step is to revise " +
    "each synthetic amber checklist item ".repeat(10).trim();
  const assistant =
    "This overview describes " +
    "each synthetic amber checklist item ".repeat(10).trim();
  await f.append([
    await f.message("user", "bounded", user, oldTime),
    await f.message("assistant", "bounded", assistant, oldTime, "assistant"),
    f.terminal("bounded", oldTime),
  ]);
  await f.migrate();
  const runner = syntheticRunner(oneCandidate);
  const options = { dir: f.dir, ...scope };
  const first = await runUntilAttempt(options, runner);
  assert.equal(first.status, "validated");
  assert.deepEqual(
    runner.prompts[0].map(({ text }) => text),
    [user],
  );
  for (let pass = 0; pass < 2; pass++) {
    const held = await runLocalDerive(options, runner);
    assert.equal(held.status, "retryable");
    assert.equal(held.reason, "CONTEXT_BUDGET");
    assert.equal(held.modelCalls, 0);
  }
  const revision = "The revised assistant overview has only one item.";
  await f.append([
    await f.message("assistant", "bounded", revision, newTime, "assistant"),
  ]);
  const recovered = await runUntilAttempt(options, runner);
  assert.equal(recovered.status, "validated");
  assert.deepEqual(
    runner.prompts.at(-1).map(({ text }) => text),
    [user, revision],
  );
  assert.equal(runner.prompts.length, 2);
  await f.assertNoReviewWrites();
});

test("missing assistant context is deferred and its exact version reenters when restored", async (t) => {
  const f = await fixture(t);
  const user = await f.message(
    "user",
    "restore",
    "Next step: prepare the synthetic checklist.",
    oldTime,
  );
  const assistant = await f.message(
    "assistant",
    "restore",
    "The synthetic checklist has two fields.",
    oldTime,
    "assistant",
  );
  const sha = assistant.metadata.original.sha256;
  const originalFile = join(f.dir, "originals", sha + ".jsonl");
  const hiddenFile = join(f.dir, "hidden-original");
  await rename(originalFile, hiddenFile);
  await f.append([user, assistant, f.terminal("restore", oldTime)]);
  await f.migrate();
  const version = (await f.item(assistant.id)).versionId;
  let checks = 0;
  const verify = originals.verifyOriginal;
  t.mock.method(originals, "verifyOriginal", async (dir, ref) => {
    if (ref?.sha256 === sha) checks++;
    return verify(dir, ref);
  });
  let clock = Date.parse("2026-01-02T00:00:00Z");
  t.mock.method(Date, "now", () => clock);
  const runner = syntheticRunner((inputs) => [
    {
      kind: "todo",
      claim: "Review the synthetic checklist.",
      evidence: inputs.map(({ source, item, version, text }) => ({
        source,
        item,
        version,
        quote: text,
      })),
    },
  ]);
  const options = { dir: f.dir, ...scope };
  const initial = await runUntilAttempt(options, runner);
  assert.equal(initial.status, "validated");
  assert.deepEqual(
    runner.prompts[0].map((input) => input.text),
    [user.text],
  );
  await runLocalDerive(options, runner);
  assert.ok(checks > 0);
  const prior = checks;
  for (let pass = 0; pass < 3; pass++) await runLocalDerive(options, runner);
  assert.equal(checks, prior);
  await rename(hiddenFile, originalFile);
  clock += 6 * 60 * 1000;
  const restored = await runUntilAttempt(options, runner);
  assert.equal(restored.status, "validated");
  assert.equal(restored.exactReferences, 2);
  assert.ok(
    runner.prompts.at(-1).some((input) => input.text === assistant.text),
  );
  assert.equal((await f.item(assistant.id)).versionId, version);
  const drafts = await f.drafts();
  assert.ok(
    drafts.some(
      (draft) =>
        draft.includes(version) && hasExactQuote(draft, assistant.text),
    ),
  );
  await f.assertNoReviewWrites();
});

test("a failed inference with no cache can retry the same exact input after a model change", async (t) => {
  const f = await fixture(t);
  const text = "Next step: prepare the synthetic model-change checklist.";
  await f.append([
    await f.message("change", "change", text, oldTime),
    f.terminal("change", oldTime),
  ]);
  await f.migrate();
  const version = (await f.item("change")).versionId;
  const runner = syntheticRunner((inputs) => {
    if (runner.prompts.length === 1)
      throw Object.assign(new Error("Synthetic inference stopped"), {
        safeLocal: true,
        code: "MEMORY_ADMISSION",
      });
    return oneCandidate(inputs);
  });
  let fingerprint = "synthetic-first-model";
  runner.prepareLocalModel = async () => ({ fingerprint });
  const options = { dir: f.dir, ...scope };
  assert.equal((await runUntilAttempt(options, runner)).status, "retryable");
  assert.deepEqual(await f.drafts(), []);
  fingerprint = "synthetic-new-model";
  const recovered = await runUntilAttempt(options, runner);
  assert.equal(recovered.status, "validated");
  assert.equal(recovered.cacheHit, false);
  assert.equal(recovered.exactReferences, 1);
  assert.deepEqual(runner.prompts, [runner.prompts[0], runner.prompts[0]]);
  const drafts = await f.drafts();
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].includes(version) && hasExactQuote(drafts[0], text));
  await f.assertNoReviewWrites();
});

test("a failed terminal already in the archive prevents inference across discovery pages", async (t) => {
  const f = await fixture(t);
  const failed = await f.message(
    "failed",
    "invalid",
    "Next step: prepare the interrupted checklist.",
    oldTime,
  );
  const padding = Array.from({ length: 100 }, (_, i) =>
    f.terminal("padding-" + i, oldTime),
  );
  await f.append([
    failed,
    f.terminal("invalid", oldTime),
    ...padding,
    f.terminal("invalid", newTime, "interrupted"),
  ]);
  await f.migrate();
  const runner = syntheticRunner(oneCandidate);
  for (let pass = 0; pass < 4; pass++) {
    assert.equal(
      (await runLocalDerive({ dir: f.dir, ...scope }, runner)).modelCalls,
      0,
    );
  }
  assert.deepEqual(runner.prompts, []);
  await f.assertNoReviewWrites();
});

test("a late interruption invalidates an exact pending retry before another inference", async (t) => {
  const f = await fixture(t);
  const text =
    "Next step: prepare the synthetic pending interruption checklist.";
  await f.append([
    await f.message("pending", "interrupted", text, oldTime),
    f.terminal("interrupted", oldTime),
  ]);
  await f.migrate();
  const runner = syntheticRunner((inputs) => {
    if (runner.prompts.length === 1)
      throw Object.assign(new Error("Synthetic resource admission failure"), {
        safeLocal: true,
        code: "MEMORY_ADMISSION",
      });
    return oneCandidate(inputs);
  });
  const options = { dir: f.dir, ...scope };
  assert.equal(
    (await runUntilAttempt(options, runner)).reason,
    "MEMORY_ADMISSION",
  );
  await f.append([f.terminal("interrupted", newTime, "interrupted")]);
  const result = await runLocalDerive(options, runner);
  assert.equal(result.status, "retryable");
  assert.equal(result.reason, "TURN_INVALIDATED");
  assert.equal(result.modelCalls, 0);
  assert.equal(runner.prompts.length, 1);
  assert.deepEqual(await f.drafts(), []);
  await f.assertNoReviewWrites();
});

test("daily reports a bounded scan and resumes the same fence despite continued imports", async (t) => {
  const f = await fixture(t);
  const text = "Next step: prepare the synthetic daily continuation checklist.";
  const noise = (batch) =>
    Array.from({ length: 400 }, (_, i) =>
      f.terminal("padding-" + batch + "-" + i, oldTime),
    );
  await f.append([
    ...noise(0),
    await f.message("eligible", "daily", text, oldTime),
    f.terminal("daily", oldTime),
  ]);
  await f.migrate();
  const op = await operations({ dir: f.dir, ...scope });
  t.after(() => op.archive.close?.());
  const version = (await f.item("eligible")).versionId;
  const runner = syntheticRunner(oneCandidate);
  const daily = () =>
    dailyReview(op, [], async () => ({ itemsImported: 0 }), {
      localDraft: true,
      localDraftRunner: (options) => runLocalDerive(options, runner),
    });
  // Allow two pages per invocation under a deterministic elapsed-time budget.
  let elapsed = 0;
  t.mock.method(performance, "now", () => (elapsed += 2000));
  const first = await daily();
  assert.equal(first.localDraftStatus, "retryable");
  assert.equal(first.localDraftReason, "SCAN_CONTINUATION");
  assert.equal(first.localModelCalls, 0);
  assert.deepEqual(runner.prompts, []);
  const statusDir = join(f.dir, "derived");
  const statuses = (await readdir(statusDir)).filter((name) =>
    name.startsWith("local-draft-"),
  );
  assert.equal(statuses.length, 1);
  const stored = JSON.parse(
    await readFile(join(statusDir, statuses[0]), "utf8"),
  );
  assert.equal(stored.localDraftReason, "SCAN_CONTINUATION");
  assert.equal(stored.localModelCalls, 0);
  let result;
  for (let batch = 1; batch <= 2; batch++) {
    await f.append(noise(batch));
    result = await daily();
    if (result.localDraftStatus === "validated") break;
    assert.equal(result.localDraftReason, "SCAN_CONTINUATION");
    assert.equal(result.localModelCalls, 0);
  }
  assert.equal(result.localDraftStatus, "validated");
  assert.equal(result.localModelCalls, 1);
  assert.equal(result.externalModelCalls, 0);
  assert.equal(result.localDraftReferences, 1);
  assert.deepEqual(
    runner.prompts.map((items) => items.map((item) => item.text)),
    [[text]],
  );
  const drafts = await f.drafts();
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].includes(version));
  assert.ok(hasExactQuote(drafts[0], text));
  await f.assertNoReviewWrites();
});

test("candidate continuation preserves earlier changed work and keeps a settled incremental high-water mark", async (t) => {
  const f = await fixture(t);
  const late = "Next step: prepare the synthetic late-terminal checklist.";
  const fresh = "Next step: prepare the synthetic new-turn checklist.";
  await f.append([
    await f.message("late", "late", late, oldTime),
    ...Array.from({ length: 119 }, (_, i) => ({
      id: "unfinished-" + i,
      kind: "message",
      role: "user",
      turnId: "unfinished-" + i,
      text: "Synthetic unfinished placeholder.",
      time: oldTime,
      metadata: { recordType: "user/message" },
    })),
  ]);
  await f.migrate();
  const runner = syntheticRunner(oneCandidate);
  const options = { dir: f.dir, ...scope };
  const run = () => runLocalDerive(options, runner);
  // Two archive pages plus one candidate page fit the first run. After
  // settling, a fresh append must fit without rescanning the old prefix.
  let elapsed = 0;
  let throttle = true;
  t.mock.method(performance, "now", () => (elapsed += throttle ? 1600 : 0));
  const initial = await run();
  assert.equal(initial.reason, "CANDIDATE_CONTINUATION");
  assert.equal(initial.modelCalls, 0);
  throttle = false;
  await f.append([f.terminal("late", oldTime)]);

  let result;
  for (let pass = 0; pass < 5; pass++) {
    result = await run();
    if (result.modelCalls === 1) break;
    assert.equal(result.reason, "CANDIDATE_CONTINUATION");
  }
  assert.equal(result.status, "validated");
  assert.equal(result.exactReferences, 1);
  assert.deepEqual(
    runner.prompts[0].map(({ text }) => text),
    [late],
  );
  for (let pass = 0; pass < 5; pass++) {
    result = await run();
    if (result.status === "no-eligible-messages") break;
    assert.equal(result.reason, "CANDIDATE_CONTINUATION");
    assert.equal(result.modelCalls, 0);
  }
  assert.equal(result.status, "no-eligible-messages");
  await f.append([
    await f.message("fresh", "fresh", fresh, newTime),
    f.terminal("fresh", newTime),
  ]);
  throttle = true;
  result = await run();
  assert.equal(result.status, "validated");
  assert.equal(result.modelCalls, 1);
  assert.equal(result.exactReferences, 1);
  assert.deepEqual(
    runner.prompts[1].map(({ text }) => text),
    [fresh],
  );
  const drafts = await f.drafts();
  for (const [id, quote] of [
    ["late", late],
    ["fresh", fresh],
  ]) {
    const { versionId } = await f.item(id);
    assert.ok(
      drafts.some(
        (draft) => draft.includes(versionId) && hasExactQuote(draft, quote),
      ),
    );
  }
  await f.assertNoReviewWrites();
});

test("a validated empty batch advances to different eligible work instead of rereading its cache", async (t) => {
  const f = await fixture(t);
  const firstText = "We decided to prepare the synthetic amber checklist.";
  const secondText = "Next step: prepare the synthetic blue checklist.";
  await f.append([
    await f.message("amber", "amber", firstText, oldTime),
    f.terminal("amber", oldTime),
    await f.message("blue", "blue", secondText, newTime),
    f.terminal("blue", newTime),
  ]);
  await f.migrate();
  const runner = syntheticRunner(() => []);
  const options = { dir: f.dir, ...scope };
  for (let i = 0; i < 2; i++) {
    const result = await runUntilAttempt(options, runner);
    assert.equal(result.status, "validated");
    assert.equal(result.candidates, 0);
    assert.equal(result.modelCalls, 1);
  }
  assert.deepEqual(
    new Set(
      runner.prompts.flatMap((inputs) => inputs.map((item) => item.text)),
    ),
    new Set([firstText, secondText]),
  );
  assert.equal((await runLocalDerive(options, runner)).modelCalls, 0);
  assert.equal(runner.prompts.length, 2);
  assert.equal((await f.drafts()).length, 2);
  await f.assertNoReviewWrites();
});

test("late terminal events and older-timestamp revisions reenter only their own scope", async (t) => {
  const f = await fixture(t);
  const oldText = "Next step: prepare the synthetic amber checklist.";
  const revisedText =
    "Next step: prepare the revised synthetic amber checklist.";
  const otherText = "Next step: prepare the other synthetic checklist.";
  await f.append([await f.message("item", "turn", oldText, oldTime)]);
  await f.append(
    [
      await f.message("item", "turn", otherText, newTime),
      f.terminal("turn", newTime),
    ],
    otherScope,
  );
  await f.migrate();
  const runner = syntheticRunner(oneCandidate);
  const options = { dir: f.dir, ...scope };
  for (let pass = 0; pass < 4; pass++)
    assert.equal((await runLocalDerive(options, runner)).modelCalls, 0);
  assert.deepEqual(runner.prompts, []);
  const other = await runUntilAttempt({ dir: f.dir, ...otherScope }, runner);
  assert.equal(other.exactReferences, 1);
  assert.deepEqual(
    runner.prompts.at(-1).map((item) => item.text),
    [otherText],
  );

  await f.append([f.terminal("turn", oldTime)]);
  const oldVersion = await f.item("item");
  assert.equal((await runUntilAttempt(options, runner)).exactReferences, 1);
  assert.deepEqual(
    runner.prompts.at(-1).map((item) => item.text),
    [oldText],
  );
  await f.append([
    await f.message("item", "turn", revisedText, "2024-12-31T00:00:00Z"),
  ]);
  const revision = await f.item("item");
  assert.notEqual(revision.versionId, oldVersion.versionId);
  assert.equal((await runUntilAttempt(options, runner)).exactReferences, 1);
  assert.deepEqual(
    runner.prompts.at(-1).map((item) => item.text),
    [revisedText],
  );
  assert.equal((await runLocalDerive(options, runner)).modelCalls, 0);
  assert.equal(runner.prompts.length, 3);
  const drafts = await f.drafts();
  assert.ok(drafts.some((draft) => draft.includes(oldVersion.versionId)));
  assert.ok(
    drafts.some(
      (draft) =>
        draft.includes(revision.versionId) && hasExactQuote(draft, revisedText),
    ),
  );
  await f.assertNoReviewWrites();
});

test("bounded candidate continuation passes unavailable originals and retries the exact valid batch", async (t) => {
  const f = await fixture(t);
  const unavailable = [];
  for (let i = 0; i < 25; i++) {
    const message = await f.message(
      "unavailable-" + i,
      "unavailable-" + i,
      "Next step: prepare synthetic unavailable checklist " + i + ".",
      oldTime,
    );
    const file = join(
      f.dir,
      "originals",
      message.metadata.original.sha256 + ".jsonl",
    );
    if (i % 2 === 0) await rm(file);
    else {
      const bytes = await readFile(file);
      bytes[0] ^= 1;
      await writeFile(file, bytes);
    }
    unavailable.push(message, f.terminal(message.turnId, oldTime));
  }
  const text = "Next step: prepare the synthetic available checklist.";
  await f.append([
    ...unavailable,
    await f.message("available", "available", text, oldTime),
    f.terminal("available", oldTime),
  ]);
  await f.migrate();
  const version = (await f.item("available")).versionId;
  const runner = syntheticRunner((inputs) => {
    if (runner.prompts.length === 1)
      throw Object.assign(new Error("Synthetic admission failure"), {
        safeLocal: true,
        code: "MEMORY_ADMISSION",
      });
    return oneCandidate(inputs);
  });
  const projection = require("../lib/local-derive-projection.cjs");
  const inspect = projection.inspectDraftEvidence;
  const inspected = [];
  t.mock.method(projection, "inspectDraftEvidence", async (...args) => {
    inspected.push(args[1].item.id);
    return inspect(...args);
  });
  const options = { dir: f.dir, ...scope };
  const op = await operations(options);
  t.after(() => op.archive.close?.());
  const first = await dailyReview(op, [], async () => ({ itemsImported: 0 }), {
    localDraft: true,
    localDraftRunner: (input) => runLocalDerive(input, runner),
  });
  assert.equal(first.localDraftStatus, "retryable");
  assert.equal(first.localDraftReason, "CANDIDATE_CONTINUATION");
  assert.equal(first.localModelCalls, 0);
  const statusFiles = (await readdir(join(f.dir, "derived"))).filter((name) =>
    name.startsWith("local-draft-"),
  );
  assert.equal(statusFiles.length, 1);
  const stored = JSON.parse(
    await readFile(join(f.dir, "derived", statusFiles[0]), "utf8"),
  );
  assert.equal(stored.localDraftReason, "CANDIDATE_CONTINUATION");
  // Selection uses at most 19 slots; five of the 24 are reserved for
  // separately reverifying a pending batch.
  assert.ok(inspected.length > 0 && inspected.length <= 19);
  const firstInspected = new Set(inspected);
  assert.deepEqual(runner.prompts, []);

  const failed = await runUntilAttempt(options, runner);
  assert.ok(inspected.some((id) => !firstInspected.has(id)));
  assert.ok(inspected.includes("available"));
  assert.equal(failed.status, "retryable");
  assert.equal(failed.reason, "MEMORY_ADMISSION");
  assert.deepEqual(
    runner.prompts[0].map((item) => item.text),
    [text],
  );
  const recovered = await runUntilAttempt(options, runner);
  assert.equal(recovered.status, "validated");
  assert.deepEqual(runner.prompts[1], runner.prompts[0]);
  const drafts = await f.drafts();
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].includes(version) && hasExactQuote(drafts[0], text));
  for (let pass = 0; pass < 3; pass++) {
    assert.equal((await runLocalDerive(options, runner)).modelCalls, 0);
  }
  assert.equal(runner.prompts.length, 2);
  assert.equal((await f.drafts()).length, 1);
  await f.assertNoReviewWrites();
});
