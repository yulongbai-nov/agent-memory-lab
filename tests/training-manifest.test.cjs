"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const {
  buildTrainingManifest,
} = require("../lib/generated/training-manifest.cjs");
const root = path.resolve(__dirname, "..");

function reference(overrides = {}) {
  return {
    owner: "synthetic-owner",
    project: "synthetic-project",
    harness: "synthetic-harness",
    instance: "synthetic-instance",
    session: "session-a",
    entry: "entry-a",
    revision: "revision-a",
    ...overrides,
  };
}

function input() {
  const ref = reference();
  return {
    registry: [{ ...ref, contentHash: `sha256:${"a".repeat(64)}` }],
    grants: [{ ...ref, purpose: "training" }],
    samples: [
      {
        id: "sample-a",
        purpose: "training",
        split: "train",
        labels: ["decision"],
        query: "What was decided?",
        expected: "A synthetic decision.",
        evidence: [ref],
      },
    ],
  };
}

function cli(...args) {
  return spawnSync(
    process.execPath,
    [path.join(root, "bin/memory.cjs"), "training-manifest", ...args],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

test("synthetic CLI does not read private directories or contact services", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-guard-"));
  const guard = path.join(temp, "guard.cjs");
  const violations = path.join(temp, "violations");
  const privateHome = os.homedir();
  fs.writeFileSync(
    guard,
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const net = require('node:net');
    const originalAppend = fs.appendFileSync;
    const report = () => { originalAppend(${JSON.stringify(violations)}, 'blocked\\n'); throw Error('blocked by acceptance guard'); };
    const privateHome = ${JSON.stringify(privateHome)};
    const root = ${JSON.stringify(root)};
    function check(value) {
      if (typeof value !== 'string') return;
      const resolved = path.resolve(value);
      if (resolved.startsWith(privateHome + path.sep) && !resolved.startsWith(root + path.sep)) report();
    }
    for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'readdirSync', 'readdir']) {
      const original = fs[name];
      fs[name] = function(value, ...args) { check(value); return original.call(this, value, ...args); };
    }
    net.Socket.prototype.connect = report;
    globalThis.fetch = report;
  `,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        guard,
        path.join(root, "bin/memory.cjs"),
        "training-manifest",
        "--synthetic",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, HOME: path.join(temp, "home") },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.existsSync(violations),
      false,
      "private read or network attempt was blocked",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("exact scoped evidence needs a grant for its own purpose", () => {
  const base = input();
  assert.doesNotThrow(() => buildTrainingManifest(base));
  for (const field of [
    "owner",
    "project",
    "harness",
    "instance",
    "session",
    "entry",
    "revision",
  ]) {
    const modified = structuredClone(base);
    modified.samples[0].evidence[0][field] += "-other";
    assert.throws(
      () => buildTrainingManifest(modified),
      `must reject mismatched ${field}`,
    );
  }
  const evaluation = structuredClone(base);
  evaluation.samples[0].purpose = "evaluation";
  evaluation.samples[0].split = "test";
  assert.throws(() => buildTrainingManifest(evaluation));
  evaluation.grants.push({ ...reference(), purpose: "evaluation" });
  assert.doesNotThrow(() => buildTrainingManifest(evaluation));
});

test("synthetic authority rejects changed fixture bytes", (t) => {
  const {
    buildSyntheticTrainingManifest,
  } = require("../lib/generated/synthetic-training-manifest.cjs");
  const read = fs.readFileSync;
  const fixture = path.join(root, "examples", "synthetic.json");
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === fixture) return Buffer.from("{}");
    return read(file, ...args);
  });
  assert.throws(
    buildSyntheticTrainingManifest,
    /Synthetic fixture digest mismatch/,
  );
});

test("a source session cannot leak across splits through revision or scope copies", () => {
  for (const change of [
    { revision: "revision-b", entry: "entry-b" },
    { owner: "other-owner", project: "other-project", entry: "entry-b" },
    {
      harness: "other-harness",
      instance: "other-instance",
      session: "other-session",
    },
  ]) {
    const base = input();
    const second = reference(change);
    const sourceSessionId = change.harness ? "same-source-session" : undefined;
    if (sourceSessionId) base.registry[0].sourceSessionId = sourceSessionId;
    base.registry.push({
      ...second,
      ...(sourceSessionId ? { sourceSessionId } : {}),
      contentHash: `sha256:${"b".repeat(64)}`,
    });
    base.grants.push({ ...second, purpose: "evaluation" });
    base.samples.push({
      id: "sample-b",
      purpose: "evaluation",
      split: "test",
      labels: ["negative"],
      query: "Was a decision made?",
      expected: "No evidence.",
      evidence: [second],
    });
    assert.throws(() => buildTrainingManifest(base));
  }
});

test("manifest version is deterministic and changes with the dataset", () => {
  const base = input();
  base.samples[0].validTime = "2026-03-01T10:00:00.000000001+01:00";
  base.samples[0].observedTime = "2026-03-01T11:00:00.123456789Z";
  const first = buildTrainingManifest(base);
  assert.equal(first.samples[0].validTime, base.samples[0].validTime);
  assert.equal(first.samples[0].observedTime, base.samples[0].observedTime);
  base.registry.push({
    ...reference({ entry: "unused" }),
    contentHash: `sha256:${"c".repeat(64)}`,
    excerpt: "Unused source material.",
  });
  assert.deepEqual(buildTrainingManifest(structuredClone(base)), first);
  const changed = structuredClone(base);
  changed.samples[0].expected = "A different synthetic decision.";
  assert.notEqual(
    buildTrainingManifest(changed).contentHash,
    first.contentHash,
  );
});

test("synthetic CLI is deterministic and refuses arbitrary input", () => {
  const first = cli("--synthetic");
  const second = cli("--synthetic");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const { manifest, fixtures } = JSON.parse(first.stdout);
  assert.ok(fixtures.length >= 2);
  const authorizationIds = fixtures.map(
    ({ sha256 }) => "synthetic-fixture:" + sha256,
  );
  assert.ok(
    manifest.grants.every((grant) =>
      authorizationIds.includes(grant.authorizationId),
    ),
  );
  assert.ok(
    manifest.registry.every(
      (entry) => typeof entry.excerpt === "string" && entry.excerpt.length > 0,
    ),
  );
  const oldSource = manifest.registry.find(
    (entry) => entry.entry === "route-tuesday",
  );
  assert.equal(oldSource?.excerpt, "The blue lantern route is Tuesday.");
  const heldout = manifest.samples.filter((sample) => sample.split === "test");
  for (const label of ["conflict", "negative"]) {
    assert.ok(
      heldout.some((sample) => sample.labels.includes(label)),
      `held-out ${label} sample missing`,
    );
  }
  assert.ok(
    heldout.some((sample) => sample.validTime),
    "held-out valid time missing",
  );
  assert.ok(
    heldout.some(
      (sample) =>
        sample.observedTime &&
        sample.validTime &&
        sample.observedTime !== sample.validTime,
    ),
    "held-out valid and observed times must be distinct",
  );
  const conflict = heldout.find((sample) => sample.labels.includes("conflict"));
  assert.match(conflict.expected, /unresolved|conflict/i);
  assert.ok(conflict.evidence.length >= 2);
  const negative = heldout.find((sample) => sample.labels.includes("negative"));
  assert.match(negative.expected, /\bno\b|not|cannot|unknown/i);
  assert.equal(manifest.version, "training-manifest-v1");
  assert.match(manifest.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(manifest.samples.length > 0);
  for (const args of [
    [],
    ["--synthetic", "--input", "/tmp/input.json"],
    ["/tmp/input.json"],
    ["--synthetic", "--unknown"],
  ]) {
    assert.notEqual(
      cli(...args).status,
      0,
      `must reject ${JSON.stringify(args)}`,
    );
  }
});
