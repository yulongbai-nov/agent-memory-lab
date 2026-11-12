"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const { bounds, matchesTime, compareTime } = require("../lib/query-time.cjs");
const { openArchive } = require("../lib/archive.cjs"),
  { createQuery } = require("../lib/query.cjs"),
  { migrateJsonToSqlite } = require("../lib/storage-sqlite.cjs");
test("strict instants, UTC dates and inclusive timestamp end", () => {
  const a = "2026-01-01T00:00:00Z";
  assert.equal(compareTime(a, "2026-01-01T01:00:00.000+01:00"), 0);
  for (const s of [
    "2026-02-30T00:00:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00.0000000001Z",
    "2026-01-01T00:00:00",
  ])
    assert.throws(() => bounds({ from: s }), /Invalid/);
  assert.equal(
    matchesTime("2026-01-01T23:59:59.999Z", { to: "2026-01-01" }),
    true,
  );
  assert.equal(
    matchesTime("2026-01-01T23:59:59.999999Z", { to: "2026-01-01" }),
    true,
  );
  assert.equal(
    matchesTime("2026-01-01T00:00:00.123456Z", {
      to: "2026-01-01T00:00:00.123Z",
    }),
    false,
  );
  assert.ok(
    compareTime("2026-01-01T00:00:00.123456Z", "2026-01-01T00:00:00.123455Z") >
      0,
  );
  assert.equal(
    compareTime(
      "2026-01-01T00:00:00.123456000Z",
      "2026-01-01T01:00:00.123456+01:00",
    ),
    0,
  );
  assert.equal(
    matchesTime("2026-01-02T00:00:00Z", { to: "2026-01-01" }),
    false,
  );
  assert.equal(
    matchesTime(a, { from: "2026-01-01T01:00:00+01:00", to: a }),
    true,
  );
  assert.equal(matchesTime("", { from: a }), false);
  assert.ok(compareTime("2026-01-01T00:30:00+01:00", a) < 0);
  assert.ok(compareTime("", a, true) > 0);
  for (const v of ["2026-02-30", "bad", "2026-01-01T00:00:00.1234567890Z"])
    assert.throws(() => bounds({ from: v }), /Invalid/);
  assert.throws(() => bounds({ to: "9999-12-31" }), /upper boundary/);
});
test("JSON and SQLite agree on range, order, source fidelity and actual preview CLI", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "query-time-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scope = { owner: "synthetic", project: "clock" },
    source = { harness: "test", instance: "one", session: "s" };
  const a = await openArchive({ dir });
  await a.importBatch({
    scope,
    source,
    checkpoint: { position: 1 },
    items: [
      {
        id: "a",
        kind: "message",
        role: "user",
        text: "needle A",
        time: "2026-01-01T00:00:00Z",
        metadata: { topic: "A" },
      },
      {
        id: "b",
        kind: "message",
        role: "user",
        text: "needle B",
        time: "2026-01-01T01:00:00.000+01:00",
        metadata: { topic: "B" },
      },
      {
        id: "c",
        kind: "message",
        role: "user",
        text: "needle C",
        time: "2026-01-01T00:30:00+01:00",
        metadata: { topic: "C" },
      },
      {
        id: "d",
        kind: "message",
        role: "user",
        text: "needle D",
        time: "2026-01-01T23:59:59.999Z",
        metadata: { topic: "D" },
      },
      {
        id: "f",
        kind: "message",
        role: "user",
        text: "needle F",
        time: "2026-01-01T23:59:59.999999999Z",
        metadata: { topic: "F" },
      },
      {
        id: "e",
        kind: "message",
        role: "user",
        text: "needle E",
        time: "2026-01-02T00:00:00Z",
        metadata: { topic: "E" },
      },
      {
        id: "u",
        kind: "message",
        role: "user",
        text: "needle unknown",
        time: "2026-01-01",
        metadata: { topic: "U" },
      },
    ],
  });
  const snapshot = async (archive) => {
    const q = createQuery(archive);
    return {
      at: await q.find({
        ...scope,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-01T01:00:00+01:00",
      }),
      day: await q.find({ ...scope, from: "2026-01-01", to: "2026-01-01" }),
      webDay: await q.find({
        ...scope,
        from: "2026-01-01T00:00:00Z",
        to: "2026-01-02T00:00:00Z",
        toExclusive: true,
      }),
      exactMicro: await q.find({
        ...scope,
        from: "2026-01-01T23:59:59.999999999Z",
        to: "2026-01-01T23:59:59.999999999Z",
      }),
      legacy: await q.find({ ...scope, keyword: "unknown" }),
      timeline: await q.timeline({ ...scope }),
    };
  };
  const before = await snapshot(a);
  assert.deepEqual(
    before.at.topics.map((x) => x.topic),
    ["A", "B"],
  );
  assert.deepEqual(
    before.day.topics.map((x) => x.topic),
    ["F", "D", "A", "B"],
  );
  assert.deepEqual(
    before.webDay.topics.map((x) => x.topic),
    ["F", "D", "A", "B"],
  );
  assert.deepEqual(
    before.exactMicro.topics.map((x) => x.topic),
    ["F"],
  );
  assert.deepEqual(
    before.legacy.topics.map((x) => x.topic),
    ["U"],
  );
  assert.deepEqual(
    before.timeline.map((x) => x.citation.id),
    ["c", "a", "b", "d", "f", "e", "u"],
  );
  await assert.rejects(
    createQuery(a).find({ ...scope, from: "nonsense" }),
    /Invalid/,
  );
  await migrateJsonToSqlite({ dir });
  const after = await openArchive({ dir });
  assert.deepEqual(await snapshot(after), before);
  const run = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "../bin/memory.cjs"),
      "find",
      "--preview",
      "--dir",
      dir,
      "--owner",
      scope.owner,
      "--project",
      scope.project,
      "--from",
      "2026-01-01T00:00:00Z",
      "--to",
      "2026-01-01T01:00:00+01:00",
      "--keyword",
      "needle",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(
    result.topics.map((x) => x.topic),
    ["A", "B"],
  );
  assert.ok(result.topics.every((x) => x.preview));
});
test("browser local day boundaries honor DST and skipped midnight", async () => {
  const server = await fs.readFile(
    path.join(__dirname, "../lib/web/server.cjs"),
    "utf8",
  );
  const fn = server.match(
    /function localDayBoundary\(value, end\) \{[^\n]+\}/,
  )[0];
  for (const [zone, day, hours] of [
    ["Europe/Oslo", "2026-03-29", 23],
    ["Europe/Oslo", "2026-10-25", 25],
    ["America/Santiago", "2026-09-06", 23],
  ]) {
    const script =
      fn +
      `; process.stdout.write(JSON.stringify([localDayBoundary('${day}',false),localDayBoundary('${day}',true)]));`;
    const run = spawnSync(process.execPath, ["-e", script], {
      env: { PATH: process.env.PATH, TZ: zone },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const [from, to] = JSON.parse(run.stdout);
    assert.equal(Date.parse(to) - Date.parse(from), hours * 3600000);
  }
  assert.match(server, /resolvedOptions\(\)\.timeZone/);
});

test("current respects sub-millisecond effective times and backwards changes", async () => {
  const scope = { owner: "synthetic", project: "clock", topic: "T" };
  const decision = (id, valid_time, kind, revises = []) => ({
    id,
    revision: id,
    text: id,
    valid_time,
    metadata: { topic: "T", reviewed: true, kind, basis: "confirmed", revises },
  });
  let records = [
    decision("old", "2026-01-01T00:00:00.123100Z", "decision"),
    decision("new", "2026-01-01T00:00:00.123900Z", "change", ["old"]),
  ];
  const query = createQuery({
    listItems: async () => records,
    getItem: async () => null,
    listAnnotations: async () => [],
  });
  assert.equal(
    (await query.current({ ...scope, asOf: "2026-01-01T00:00:00.123500Z" }))[0]
      .text,
    "old",
  );
  assert.equal(
    (
      await query.current({
        ...scope,
        asOf: "2026-01-01T01:00:00.123900+01:00",
      })
    )[0].text,
    "new",
  );
  records = [
    decision("old", "2026-01-01T00:00:00.123900Z", "decision"),
    decision("new", "2026-01-01T00:00:00.123100Z", "change", ["old"]),
  ];
  assert.equal(
    (await query.current({ ...scope, asOf: "2026-01-01T00:00:01Z" }))[0].label,
    "待核实",
  );
  records = [
    decision("legacy", "2026-01-01", "decision"),
    decision("bad", "invalid", "decision"),
  ];
  assert.equal(
    (await query.current({ ...scope, asOf: "2026-01-02" }))[0].text,
    "legacy",
  );
  assert.deepEqual(await query.current({ ...scope, asOf: "invalid" }), []);
  records.push(
    decision("next", "2026-01-01T00:00:00.000000001Z", "change", ["legacy"]),
  );
  assert.equal(
    (await query.current({ ...scope, asOf: "2026-01-01" }))[0].text,
    "legacy",
  );
});

test("decision boundaries deduplicate equivalent offsets without collapsing fractional instants", () => {
  const { decisionBoundaries } = require("../lib/query.cjs");
  const record = (id, valid_time) => ({
    id,
    revision: id,
    valid_time,
    metadata: { reviewed: true, kind: "decision", topic: "T" },
  });
  const boundaries = decisionBoundaries(
    [
      record("a", "2026-01-01T00:00:00.123100Z"),
      record("b", "2026-01-01T01:00:00.123100000+01:00"),
      record("c", "2026-01-01T00:00:00.123900Z"),
    ],
    [],
  );
  assert.deepEqual(
    boundaries.map((time) => time.iso),
    ["2026-01-01T00:00:00.1231Z", "2026-01-01T00:00:00.1239Z"],
  );
});
