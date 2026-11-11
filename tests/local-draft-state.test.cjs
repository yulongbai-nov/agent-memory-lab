"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  createState,
  validateState,
  enqueue,
  nextDue,
  fail,
  bindCache,
  rebindMissingCache,
  complete,
} = require("../lib/generated/local-draft-state.cjs");
const hash = (n) => n.toString(16).padStart(64, "0");
const makeJob = (n) => ({
  key: hash(n),
  projectionDigest: hash(n + 100),
  refs: [
    {
      source: { harness: "codex", instance: "i", session: "s" },
      item: "item",
      version: `v${n}`,
    },
  ],
  attempts: 0,
  retryAt: 0,
});
const makeState = () =>
  createState({
    scopeKey: hash(99),
    selectorVersion: "local-select-v1",
    promptVersion: "local-derive-v4",
  });
test("serializable bounded queue rejects identity collision and preserves state on full", () => {
  let s = makeState();
  for (let n = 1; n <= 8; n++) {
    const r = enqueue(s, makeJob(n));
    assert.equal(r.status, "added");
    s = r.state;
  }
  const before = JSON.stringify(s);
  assert.equal(enqueue(s, makeJob(9)).status, "full");
  assert.equal(JSON.stringify(s), before);
  assert.equal(enqueue(s, makeJob(1)).status, "duplicate");
  assert.throws(() =>
    enqueue(s, { ...makeJob(1), projectionDigest: hash(999) }),
  );
  assert.throws(() =>
    enqueue(s, {
      ...makeJob(1),
      refs: [{ ...makeJob(1).refs[0], version: "different" }],
    }),
  );
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(s))), s);
});
test("failure retains exact refs, round-robin selects other work, and bounded retry survives replay", () => {
  let s = enqueue(enqueue(makeState(), makeJob(1)).state, makeJob(2)).state;
  let r = nextDue(s, 100);
  assert.equal(r.job.key, hash(1));
  s = fail(r.state, hash(1), 100, "MODEL_UNAVAILABLE");
  assert.equal(s.jobs[0].retryAt, 100);
  assert.deepEqual(s.jobs[0].refs, makeJob(1).refs);
  r = nextDue(JSON.parse(JSON.stringify(s)), 100);
  assert.equal(r.job.key, hash(2));
  s = fail(r.state, hash(1), 100, "MODEL_UNAVAILABLE");
  assert.equal(s.jobs[0].retryAt, 1100);
  r = nextDue(s, 100);
  assert.equal(r.job.key, hash(2));
  for (let i = 0; i < 20; i++) s = fail(s, hash(1), 100, "MODEL_UNAVAILABLE");
  assert.equal(s.jobs[0].retryAt, 300100);
  assert.equal(nextDue(s, 300100).job.key, hash(1));
});
test("cache binding is stable and completion removes only selected job", () => {
  let s = enqueue(enqueue(makeState(), makeJob(1)).state, makeJob(2)).state;
  s = bindCache(s, hash(1), hash(77));
  assert.equal(bindCache(s, hash(1), hash(77)).jobs[0].cacheKey, hash(77));
  assert.throws(() => bindCache(s, hash(1), hash(78)));
  assert.throws(() => bindCache(s, hash(3), hash(77)));
  s = complete(s, hash(1));
  assert.deepEqual(
    s.jobs.map((x) => x.key),
    [hash(2)],
  );
  assert.throws(() => complete(s, hash(1)));
});
test("rejects malformed state, version, bounds, reason and timestamps", () => {
  const good = enqueue(makeState(), makeJob(1)).state;
  for (const bad of [
    { ...good, schemaVersion: 2 },
    { ...good, scopeKey: "bad" },
    { ...good, rotation: 1 },
    { ...good, jobs: [...good.jobs, ...good.jobs] },
    { ...good, jobs: [{ ...good.jobs[0], refs: [] }] },
    { ...good, jobs: [{ ...good.jobs[0], unknown: "x" }] },
    { ...good, jobs: [{ ...good.jobs[0], attempts: 1, reason: "unsafe" }] },
  ])
    assert.throws(() => validateState(bad));
  assert.throws(() => fail(good, hash(1), 0, "unknown"));
  assert.throws(() => nextDue(good, -1));
  assert.throws(() =>
    enqueue(makeState(), {
      ...makeJob(1),
      refs: Array(6).fill(makeJob(1).refs[0]),
    }),
  );
  assert.throws(() =>
    enqueue(makeState(), {
      ...makeJob(1),
      refs: [{ ...makeJob(1).refs[0], item: "x".repeat(1025) }],
    }),
  );
});

test("rebind requires the exact prior cache key and preserves serialized work", () => {
  const initial = enqueue(makeState(), makeJob(1)).state;
  assert.throws(() => rebindMissingCache(initial, hash(1), hash(77), hash(78)));
  const bound = bindCache(initial, hash(1), hash(77));
  for (const [key, old, next] of [
    [hash(1), hash(76), hash(78)],
    [hash(1), "bad", hash(78)],
    [hash(1), hash(77), "bad"],
    [hash(2), hash(77), hash(78)],
  ])
    assert.throws(() => rebindMissingCache(bound, key, old, next));
  assert.equal(bound.jobs[0].cacheKey, hash(77));
  const changed = rebindMissingCache(
    JSON.parse(JSON.stringify(bound)),
    hash(1),
    hash(77),
    hash(78),
  );
  assert.equal(changed.jobs[0].cacheKey, hash(78));
  assert.deepEqual(changed.jobs[0].refs, bound.jobs[0].refs);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(changed))), changed);
});

test("daily safe failure reasons survive a state round trip", () => {
  const reasons = [
    "INVALID_INPUT",
    "LOCAL_FAILED",
    "LOCAL_UNSUPPORTED",
    "LOCAL_VALIDATION_OR_CACHE_FAILED",
    "MODEL_CHANGED",
    "MODEL_INVALID",
    "MODEL_NOT_PREPARED",
    "MODEL_UNAVAILABLE",
    "MODEL_NOCACHE_FAILED",
    "MODEL_NOCACHE_UNAVAILABLE",
    "MODEL_NOCACHE_TIMEOUT",
    "SANDBOX_UNVERIFIED",
    "MEMORY_ADMISSION",
    "MEMORY_PRESSURE",
    "MEMORY_UNAVAILABLE",
    "RSS_LIMIT",
    "RSS_UNAVAILABLE",
    "TIME_LIMIT",
    "OUTPUT_LIMIT",
    "DIAGNOSTIC_LIMIT",
    "PROCESS_FAILED",
    "ORIGINAL_UNAVAILABLE",
    "INPUT_LIMIT",
    "OUTPUT_WRITE_FAILED",
  ];
  const initial = enqueue(makeState(), makeJob(1)).state;
  for (const reason of reasons) {
    const failed = fail(initial, hash(1), 100, reason);
    assert.equal(
      validateState(JSON.parse(JSON.stringify(failed))).jobs[0].reason,
      reason,
    );
  }
  assert.throws(() => fail(initial, hash(1), 100, "UNSAFE_UNKNOWN"));
});
