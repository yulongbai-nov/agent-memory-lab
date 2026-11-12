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

function digest(value) {
  return `sha256:${require("node:crypto").createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function refKey(ref) {
  return JSON.stringify([
    ref.owner,
    ref.project,
    ref.harness,
    ref.instance,
    ref.session,
    ref.entry,
    ref.revision,
  ]);
}

test("CLI split exports contain only their authorized sessions and preserve exact evidence", () => {
  const fullResult = cli("--synthetic");
  assert.equal(fullResult.status, 0, fullResult.stderr);
  const fullBytes = fullResult.stdout;
  const { manifest } = JSON.parse(fullBytes);
  const exports = {};
  for (const split of ["train", "test"]) {
    const first = cli("--synthetic", "--split", split);
    const second = cli("--synthetic", "--split", split);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    const output = JSON.parse(first.stdout);
    exports[split] = output;
    assert.deepEqual(Object.keys(output).sort(), [
      "contentHash",
      "evidenceRegistry",
      "samples",
      "sourceManifestHash",
      "split",
      "version",
    ]);
    assert.equal(output.version, "training-split-v1");
    assert.equal(output.split, split);
    assert.equal(output.sourceManifestHash, manifest.contentHash);
    const { contentHash, ...body } = output;
    assert.equal(contentHash, digest(body));
    const selected = manifest.samples.filter(
      (sample) => sample.split === split,
    );
    assert.deepEqual(
      output.samples.map((sample) => sample.id),
      selected.map((sample) => sample.id),
    );
    const used = new Set(
      selected.flatMap((sample) => sample.evidence.map(refKey)),
    );
    const expectedRegistry = manifest.registry.filter((entry) =>
      used.has(refKey(entry)),
    );
    assert.deepEqual(
      output.evidenceRegistry.map((entry) => refKey(entry.ref)),
      expectedRegistry.map(refKey),
    );
    for (const entry of output.evidenceRegistry) {
      const parent = expectedRegistry.find(
        (item) => refKey(item) === refKey(entry.ref),
      );
      const grant = manifest.grants.find(
        (item) =>
          refKey(item) === refKey(entry.ref) &&
          item.purpose === (split === "train" ? "training" : "evaluation"),
      );
      assert.equal(entry.contentHash, parent.contentHash);
      assert.equal(entry.authorizationId, grant.authorizationId);
      assert.equal(entry.purpose, grant.purpose);
      assert.equal(entry.sourceSessionId, parent.sourceSessionId);
      assert.deepEqual(Object.keys(entry).sort(), [
        "authorizationId",
        "contentHash",
        "purpose",
        "ref",
        ...(parent.sourceSessionId ? ["sourceSessionId"] : []),
      ]);
    }
    for (const sample of output.samples) {
      const parent = selected.find((item) => item.id === sample.id);
      assert.deepEqual(Object.keys(sample).sort(), ["expected", "id", "input"]);
      assert.deepEqual(Object.keys(sample.input).sort(), ["evidence", "query"]);
      assert.deepEqual(
        Object.keys(sample.expected).sort(),
        [
          "answer",
          "labels",
          ...(parent.observedTime ? ["observedTime"] : []),
          ...(parent.validTime ? ["validTime"] : []),
        ].sort(),
      );
      assert.equal(sample.input.query, parent.query);
      assert.equal(sample.expected.answer, parent.expected);
      assert.deepEqual(sample.expected.labels, parent.labels);
      for (const field of ["validTime", "observedTime"])
        assert.equal(sample.expected[field], parent[field]);
      assert.deepEqual(
        sample.input.evidence.map((entry) => refKey(entry.ref)),
        parent.evidence.map(refKey),
      );
      for (const evidence of sample.input.evidence) {
        assert.deepEqual(Object.keys(evidence).sort(), ["excerpt", "ref"]);
        assert.equal(
          evidence.excerpt,
          expectedRegistry.find(
            (entry) => refKey(entry) === refKey(evidence.ref),
          ).excerpt,
        );
      }
      assert.equal(Object.hasOwn(sample.input, "expected"), false);
      assert.equal(Object.hasOwn(sample.input, "answer"), false);
    }
  }
  const sessions = (output) =>
    new Set(
      output.evidenceRegistry.map(({ ref }) =>
        JSON.stringify([ref.harness, ref.instance, ref.session]),
      ),
    );
  const trainSessions = sessions(exports.train);
  for (const session of sessions(exports.test))
    assert.equal(trainSessions.has(session), false);
  const old = exports.test.samples
    .find((sample) => sample.id === "graph-correction-change")
    .input.evidence.find(({ ref }) => ref.entry === "route-tuesday");
  assert.equal(old.excerpt, "The blue lantern route is Tuesday.");
  assert.equal(
    old.ref.revision,
    manifest.registry.find((entry) => entry.entry === "route-tuesday").revision,
  );
  assert.equal(cli("--synthetic").stdout, fullBytes);
});

test("split export rejects a tampered parent and wrong CLI flags", () => {
  const {
    exportTrainingSplit,
  } = require("../lib/generated/training-split.cjs");
  const { manifest } = JSON.parse(cli("--synthetic").stdout);
  const input = structuredClone(manifest);
  delete input.version;
  delete input.contentHash;
  input.registry[0].sourceSessionId = "verified-synthetic-session";
  const parent = buildTrainingManifest(input);
  const ref = parent.registry[0];
  const split = parent.samples.find((sample) =>
    sample.evidence.some((evidence) => refKey(evidence) === refKey(ref)),
  ).split;
  const exported = exportTrainingSplit(parent, split);
  assert.equal(
    exported.evidenceRegistry.find((entry) => refKey(entry.ref) === refKey(ref))
      .sourceSessionId,
    "verified-synthetic-session",
  );
  for (const mutate of [
    (value) => {
      value.samples[0].expected += " tampered";
    },
    (value) => {
      value.registry[0].excerpt += " tampered";
    },
    (value) => {
      value.contentHash = `sha256:${"0".repeat(64)}`;
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(() => exportTrainingSplit(changed, "train"));
  }
  for (const args of [
    ["--split", "train"],
    ["--synthetic", "--split", "invalid"],
    ["--synthetic", "--split"],
    ["--synthetic", "--split", "train", "--unknown"],
    ["--synthetic", "--split", "train", "--split", "test"],
  ])
    assert.notEqual(
      cli(...args).status,
      0,
      `must reject ${JSON.stringify(args)}`,
    );
  const other = spawnSync(
    process.execPath,
    [path.join(root, "bin/memory.cjs"), "status", "--split", "train"],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.notEqual(other.status, 0);
});
