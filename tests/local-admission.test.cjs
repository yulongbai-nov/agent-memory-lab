"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { waitForAdmission } = require("../lib/generated/local-admission.cjs");
const { openArchive } = require("../lib/archive.cjs");
const { runLocalDerive } = require("../lib/local-derive.cjs");
const { originalCapture } = require("../lib/originals.cjs");
const { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");

function clockHarness({
  reading,
  deadline = 60_000,
  waitLimitMs = 15_000,
  intervalMs = 1_000,
  signal,
  onSleep,
} = {}) {
  let clock = 0;
  const samples = [];
  const sleeps = [];
  const boundary = Math.min(deadline, waitLimitMs);
  return {
    samples,
    sleeps,
    elapsed: () => clock,
    run: () =>
      waitForAdmission({
        now: () => clock,
        deadline,
        waitLimitMs,
        intervalMs,
        signal,
        async sample({ timeoutMs, signal: sampleSignal }) {
          if (signal) assert.equal(sampleSignal?.aborted, signal.aborted);
          assert.ok(timeoutMs > 0 && timeoutMs <= boundary - clock);
          const index = samples.push({ at: clock, timeoutMs }) - 1;
          return reading({
            index,
            timeoutMs,
            advance: (milliseconds) => (clock += milliseconds),
          });
        },
        async sleep(ms, sleepSignal) {
          if (signal) assert.equal(sleepSignal?.aborted, signal.aborted);
          assert.ok(ms > 0 && ms <= intervalMs && ms <= boundary - clock);
          sleeps.push({ at: clock, ms });
          clock += ms;
          await onSleep?.();
        },
      }),
  };
}

test("exactly 45 percent is admitted on the initial sample without sleeping", async () => {
  const h = clockHarness({ reading: () => 45 });
  const result = await h.run();
  assert.equal(result.status, "admitted");
  assert.equal(result.lastPercent, 45);
  assert.equal(result.samples, 1);
  assert.equal(result.waitMs, 0);
  assert.deepEqual(h.sleeps, []);
});

test("an initially low reading recovers only after a bounded resample", async () => {
  const readings = [42, 44.9, 45];
  const h = clockHarness({ reading: ({ index }) => readings[index] });
  const result = await h.run();
  assert.equal(result.status, "admitted");
  assert.equal(result.lastPercent, 45);
  assert.equal(result.samples, 3);
  assert.equal(result.waitMs, 2_000);
  assert.deepEqual(
    h.samples.map(({ at }) => at),
    [0, 1_000, 2_000],
  );
});

test("persistent low pressure exhausts the wait window without overrunning it", async () => {
  const h = clockHarness({
    waitLimitMs: 2_500,
    reading: () => 42,
  });
  const result = await h.run();
  assert.equal(result.status, "low");
  assert.equal(result.lastPercent, 42);
  assert.equal(result.samples, h.samples.length);
  assert.equal(result.waitMs, 2_500);
  assert.equal(h.elapsed(), 2_500);
  assert.ok(h.samples.every(({ at }) => at < 2_500));
});

test("invalid readings or sampler errors fail closed immediately", async () => {
  for (const reading of [
    () => NaN,
    () => Infinity,
    () => -1,
    () => 101,
    () => "45",
    () => {
      throw new Error("Synthetic sampler error");
    },
  ]) {
    const h = clockHarness({ reading });
    const result = await h.run();
    assert.equal(result.status, "unavailable");
    assert.equal(result.samples, 1);
    assert.equal(h.samples.length, 1);
    assert.deepEqual(h.sleeps, []);
  }
});

test("cancellation stops admission before a sample, during sampling, or during sleep", async () => {
  const before = new AbortController();
  before.abort();
  const initial = clockHarness({ signal: before.signal, reading: () => 45 });
  assert.equal((await initial.run()).status, "cancelled");
  assert.equal(initial.samples.length, 0);

  const sampling = new AbortController();
  const abortedSample = clockHarness({
    signal: sampling.signal,
    reading() {
      sampling.abort();
      throw sampling.signal.reason;
    },
  });
  assert.equal((await abortedSample.run()).status, "cancelled");
  assert.equal(abortedSample.samples.length, 1);
  assert.deepEqual(abortedSample.sleeps, []);

  const waiting = new AbortController();
  const interrupted = clockHarness({
    signal: waiting.signal,
    reading: () => 42,
    onSleep() {
      waiting.abort();
      throw waiting.signal.reason;
    },
  });
  const result = await interrupted.run();
  assert.equal(result.status, "cancelled");
  assert.equal(result.samples, 1);
  assert.equal(interrupted.sleeps.length, 1);
});

test("the absolute deadline limits the initial sample and the whole wait", async () => {
  const expired = clockHarness({ deadline: 0, reading: () => 45 });
  assert.equal((await expired.run()).status, "timeout");
  assert.equal(expired.samples.length, 0);

  const limited = clockHarness({ deadline: 2_500, reading: () => 42 });
  const result = await limited.run();
  assert.equal(result.status, "timeout");
  assert.equal(result.waitMs, 2_500);
  assert.equal(limited.elapsed(), 2_500);
  assert.ok(limited.samples.every(({ at }) => at < 2_500));
});

test("a qualifying sample that returns at a boundary never admits inference", async () => {
  for (const [bounds, status] of [
    [{ deadline: 1_500 }, "timeout"],
    [{ waitLimitMs: 1_500 }, "low"],
  ]) {
    const h = clockHarness({
      ...bounds,
      reading({ index, timeoutMs, advance }) {
        if (index === 0) return 42;
        assert.equal(timeoutMs, 500);
        advance(timeoutMs);
        return 45;
      },
    });
    const result = await h.run();
    assert.equal(result.status, status);
    assert.equal(result.samples, 2);
    assert.equal(h.elapsed(), 1_500);
  }
});

test("admission failures keep the exact draft pending and report zero model calls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-admission-draft-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = await openArchive({ dir });
  const scope = { owner: "synthetic", project: "admission" };
  const source = { harness: "dsh", instance: "test", session: "one" };
  const text = "Next step: prepare the synthetic print checklist.";
  const original = await originalCapture(dir)({
    coordinate: 1,
    bytes: Buffer.from(
      JSON.stringify({ type: "user/message", data: { role: "user", text } }) +
        "\n",
    ),
  });
  await archive.importBatch({
    scope,
    source,
    checkpoint: { position: 2 },
    items: [
      {
        id: "user",
        kind: "message",
        role: "user",
        turnId: "turn",
        text,
        time: "2026-01-01T09:00:00Z",
        metadata: { recordType: "user/message", coordinate: 1, original },
      },
      {
        id: "end",
        kind: "event",
        status: "completed",
        turnId: "turn",
        time: "2026-01-01T09:01:00Z",
        metadata: { recordType: "turn/end", coordinate: 2 },
      },
    ],
  });
  archive.close?.();
  await migrateJsonToSqlite({ dir });
  let clock = Date.parse("2026-01-02T00:00:00Z");
  t.mock.method(Date, "now", () => clock);
  const prompts = [];
  let controller;
  const runner = {
    async prepareLocalModel() {
      return { fingerprint: "synthetic-admission-stub" };
    },
    async runLocalLlama({ prompt, signal }) {
      prompts.push(prompt);
      if (prompts.length <= 2) {
        assert.equal(signal, controller.signal);
        const abort = prompts.length === 2;
        const pressure = clockHarness({
          reading: () => 42,
          signal,
          waitLimitMs: 2_000,
          onSleep() {
            if (abort) controller.abort();
          },
        });
        const outcome = await pressure.run();
        throw Object.assign(new Error("Synthetic local admission failure"), {
          safeLocal: true,
          code:
            outcome.status === "cancelled" ? "CANCELLED" : "MEMORY_ADMISSION",
          stats: {
            inferenceStarted: false,
            admissionWaitMs: outcome.waitMs,
            admissionSamples: outcome.samples,
            admissionLastPercent: outcome.lastPercent,
          },
        });
      }
      const [row] = JSON.parse(prompt.split("\n").at(-1));
      return {
        output: JSON.stringify({
          candidates: [
            {
              kind: "todo",
              claim: "Prepare the synthetic checklist.",
              evidence: [
                {
                  source: row.source,
                  item: row.item,
                  version: row.version,
                  quote: row.text,
                },
              ],
            },
          ],
        }),
        stats: { inferenceStarted: true },
      };
    },
  };
  const draftFiles = async () =>
    (await readdir(join(dir, "local-derive"))).filter((name) =>
      name.endsWith(".txt"),
    );
  for (const [code, elapsed, samples] of [
    ["MEMORY_ADMISSION", 2_000, 2],
    ["CANCELLED", 1_000, 1],
  ]) {
    controller = new AbortController();
    const result = await runLocalDerive(
      { dir, ...scope, signal: controller.signal },
      runner,
    );
    assert.equal(result.status, "retryable");
    assert.equal(result.reason, code);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.stats.admissionWaitMs, elapsed);
    assert.equal(result.stats.admissionSamples, samples);
    assert.equal(result.stats.admissionLastPercent, 42);
    assert.deepEqual(await draftFiles(), []);
    clock += 10_000;
  }
  const result = await runLocalDerive({ dir, ...scope }, runner);
  assert.equal(result.status, "validated");
  assert.equal(result.modelCalls, 1);
  assert.equal(result.exactReferences, 1);
  assert.equal(prompts.length, 3);
  assert.equal(new Set(prompts).size, 1);
  assert.equal((await draftFiles()).length, 1);
});

const cliStub = `
const Module = require("node:module");
const assert = require("node:assert/strict");
const load = Module._load;
const entry = process.argv[1];
const mode = process.env.SYNTHETIC_ADMISSION_TEST_MODE;
const ready = () => process.stdout.write("synthetic-ready\\n");
Module._load = function(request, parent, ...rest) {
  if (parent?.filename === entry) {
    if (mode === "plain" && request === "../lib/daily.cjs") {
      return {
        async dailyReview(_op, _manifest, _ingest, options) {
          assert.equal(options.localDraft, false);
          setInterval(() => {}, 1000);
          ready();
          return new Promise(() => {});
        },
      };
    }
    if (request === "../lib/local-derive.cjs") {
      return {
        async runLocalDerive({signal}) {
          assert.ok(signal && !signal.aborted);
          await new Promise(resolve => {
            const keepAlive = setInterval(() => {}, 1000);
            signal.addEventListener("abort", () => {
              clearInterval(keepAlive);
              resolve();
            }, {once:true});
            ready();
          });
          return {status:"retryable",reason:"CANCELLED",modelCalls:0,inputs:0};
        },
      };
    }
  }
  return load.call(this, request, parent, ...rest);
};
`;

function signalAfterReady(t, preload, entry, mode, args, requestedSignal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--require", preload, entry, ...args],
      {
        env: { SYNTHETIC_ADMISSION_TEST_MODE: mode },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    let signalled = false;
    child.stdout.on("data", (data) => {
      stdout += data.toString();
      if (!signalled && stdout.includes("synthetic-ready\n")) {
        signalled = child.kill(requestedSignal);
      }
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!signalled)
        return reject(
          new Error("CLI stub did not become ready (" + mode + "): " + stderr),
        );
      resolve({
        code,
        signal,
        json: stdout.split("\n").slice(1).join("\n").trim(),
      });
    });
  });
}

test(
  "draft CLI signals cancel only the running synthetic draft with standard exit codes",
  { timeout: 10_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "synthetic-admission-cli-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const preload = join(dir, "fixture-preload.cjs");
    await writeFile(preload, cliStub, { mode: 0o600 });
    const scope = [
      "--dir",
      dir,
      "--owner",
      "synthetic",
      "--project",
      "admission",
    ];
    const derive = await signalAfterReady(
      t,
      preload,
      require.resolve("../bin/local-derive.cjs"),
      "draft",
      scope,
      "SIGINT",
    );
    assert.equal(derive.code, 130);
    assert.equal(derive.signal, null);
    assert.equal(JSON.parse(derive.json).reason, "CANCELLED");
    assert.equal(JSON.parse(derive.json).modelCalls, 0);

    const memory = require.resolve("../bin/memory.cjs");
    const daily = await signalAfterReady(
      t,
      preload,
      memory,
      "draft",
      ["daily", "--local-draft", ...scope],
      "SIGTERM",
    );
    assert.equal(daily.code, 143);
    assert.equal(daily.signal, null);
    assert.equal(JSON.parse(daily.json).localDraftReason, "CANCELLED");
    assert.equal(JSON.parse(daily.json).localModelCalls, 0);

    const plain = await signalAfterReady(
      t,
      preload,
      memory,
      "plain",
      ["daily", ...scope],
      "SIGTERM",
    );
    assert.equal(plain.code, null);
    assert.equal(plain.signal, "SIGTERM");
  },
);
