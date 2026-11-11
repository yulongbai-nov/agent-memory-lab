"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Ajv = require("ajv");
const {
  PROTOCOL,
  OUTPUT_SCHEMA_V2,
  validateVersionedCandidates,
} = require("../lib/candidate-contract-v2.cjs");
const {
  OUTPUT_SCHEMA,
  validateCandidates,
} = require("../lib/semantic-validation.cjs");
const schemaValid = new Ajv({ allErrors: true }).compile(OUTPUT_SCHEMA_V2);
const wrap = (candidates, protocol = PROTOCOL) => ({ protocol, candidates });
const source = (text) => ({
  source: "synthetic/source",
  item: "message-1",
  version: "version-1",
  text,
});
const candidate = (kind, claim, quote, basis) => ({
  kind,
  ...(basis === undefined ? {} : { basis }),
  claim,
  evidence: [
    {
      source: "synthetic/source",
      item: "message-1",
      version: "version-1",
      quote,
    },
  ],
});

test("v2 requires decision basis and never accepts caller review or lifecycle fields", () => {
  const records = [source("已决定使用蓝色方案。")],
    good = candidate(
      "decision",
      "决定使用蓝色方案",
      "已决定使用蓝色方案",
      "confirmed",
    );
  for (const basis of ["confirmed", "proposed", "uncertain"]) {
    const out = wrap([{ ...good, basis }]);
    assert.equal(schemaValid(out), true);
    const result = validateVersionedCandidates(out, records);
    assert.equal(result[0].basis, basis);
    assert.equal(result[0].status, "待核实");
  }
  for (const bad of [
    wrap([{ ...good, basis: "unknown" }]),
    wrap([candidate("decision", "决定使用蓝色方案", "已决定使用蓝色方案")]),
    wrap([{ ...good, status: "已确认" }]),
    wrap([{ ...good, lifecycle: "cancelled" }]),
    wrap([{ ...good, kind: "todo" }]),
    wrap([good], "candidate-v3"),
    { candidates: [good] },
  ]) {
    assert.equal(schemaValid(bad), false);
    assert.throws(() => validateVersionedCandidates(bad, records));
  }
  for (const kind of ["change", "correction", "todo"]) {
    const out = wrap([candidate(kind, "合成事项", "蓝色方案")]);
    assert.equal(schemaValid(out), true);
    assert.equal(validateVersionedCandidates(out, records)[0].status, "待核实");
  }
  assert.deepEqual(validateVersionedCandidates(wrap([]), records), []);
  const oversized = Array(5);
  Object.defineProperty(oversized, 0, {
    get() {
      throw Error("should not inspect oversized items");
    },
  });
  assert.throws(
    () => validateVersionedCandidates(wrap(oversized), records),
    /unsupported or invalid candidate protocol/,
  );
});

test("exact source, item, version and contiguous quote remain mandatory", () => {
  const records = [source("已决定使用蓝色方案。")],
    good = candidate(
      "decision",
      "决定使用蓝色方案",
      "已决定使用蓝色方案",
      "confirmed",
    );
  for (const change of [
    { source: "synthetic/other-scope" },
    { item: "other" },
    { version: "version-2" },
    { quote: "决定绿色" },
    { quote: "" },
  ]) {
    const input = wrap([
      { ...good, evidence: [{ ...good.evidence[0], ...change }] },
    ]);
    assert.throws(() => validateVersionedCandidates(input, records));
  }
  assert.throws(() =>
    validateVersionedCandidates(
      wrap([{ ...good, evidence: [good.evidence[0], good.evidence[0]] }]),
      records,
    ),
  );
  assert.throws(() =>
    validateVersionedCandidates(wrap([good]), [...records, ...records]),
  );
  const emojiRecords = [source("标记😀完成")],
    split = candidate("todo", "合成标记", "\ud83d");
  assert.equal(
    validateCandidates({ candidates: [split] }, emojiRecords).length,
    1,
  );
  assert.throws(
    () => validateVersionedCandidates(wrap([split]), emojiRecords),
    /Unicode/,
  );
  const whole = candidate("todo", "合成标记", "😀");
  assert.equal(
    validateVersionedCandidates(wrap([whole]), emojiRecords).length,
    1,
  );
});

test("old v1 contract remains separate and does not invent a basis", () => {
  const records = [source("已决定使用蓝色方案。")],
    old = candidate("decision", "决定使用蓝色方案", "已决定使用蓝色方案");
  assert.deepEqual(OUTPUT_SCHEMA.required, ["candidates"]);
  const result = validateCandidates({ candidates: [old] }, records);
  assert.equal(result[0].status, "待核实");
  assert.equal(Object.hasOwn(result[0], "basis"), false);
  assert.throws(() =>
    validateVersionedCandidates({ candidates: [old] }, records),
  );
  assert.throws(() =>
    validateCandidates(wrap([{ ...old, basis: "confirmed" }]), records),
  );
});

// Human-labeled synthetic cases compare predicted types to independently written
// gold. The structural validator does not infer these labels from text.
test("structural acceptance is distinct from fixture-level semantic gold", () => {
  const examples = [
    {
      id: "settled",
      text: "已决定使用蓝色方案。",
      candidates: [
        candidate(
          "decision",
          "决定使用蓝色方案",
          "已决定使用蓝色方案",
          "confirmed",
        ),
      ],
      gold: ["decision:confirmed"],
      expected: true,
    },
    {
      id: "proposed",
      text: "提议使用蓝色方案，尚待选择。",
      candidates: [
        candidate(
          "decision",
          "提议使用蓝色方案",
          "提议使用蓝色方案，尚待选择",
          "proposed",
        ),
      ],
      gold: ["decision:proposed"],
      expected: true,
    },
    {
      id: "chat",
      text: "今天的天气真好。",
      candidates: [],
      gold: [],
      expected: true,
    },
    {
      id: "chat-invented-decision",
      text: "今天的天气真好。",
      candidates: [
        candidate("decision", "讨论了天气方案", "天气真好", "proposed"),
      ],
      gold: [],
      expected: false,
    },
    {
      id: "uncertain",
      text: "蓝色方案是这次会议的选择议题，决定状态尚不清楚。",
      candidates: [
        candidate(
          "decision",
          "蓝色方案的决定状态不清楚",
          "决定状态尚不清楚",
          "uncertain",
        ),
      ],
      gold: ["decision:uncertain"],
      expected: true,
    },
    {
      id: "change",
      text: "决定改用绿色方案。",
      candidates: [candidate("change", "改用绿色方案", "决定改用绿色方案")],
      gold: ["change"],
      expected: true,
    },
    {
      id: "correction",
      text: "纠正刚才的误解，原来讨论的是蓝色。",
      candidates: [
        candidate("correction", "纠正原议题的颜色", "纠正刚才的误解"),
      ],
      gold: ["correction"],
      expected: true,
    },
    {
      id: "completed",
      text: "截图断言已经完成。",
      candidates: [],
      gold: [],
      expected: true,
    },
    {
      id: "false-confirmed",
      text: "提议使用蓝色方案，尚待选择。",
      candidates: [
        candidate(
          "decision",
          "已决定使用蓝色方案",
          "提议使用蓝色方案，尚待选择",
          "confirmed",
        ),
      ],
      gold: ["decision:proposed"],
      expected: false,
    },
    {
      id: "completed-not-todo",
      text: "截图断言已经完成。",
      candidates: [candidate("todo", "截图断言待完成", "截图断言已经完成")],
      gold: [],
      expected: false,
    },
    {
      id: "wrong-claim-same-label",
      text: "已决定使用蓝色方案。",
      candidates: [
        candidate(
          "decision",
          "已决定使用绿色方案",
          "已决定使用蓝色方案",
          "confirmed",
        ),
      ],
      gold: ["decision:confirmed"],
      goldClaims: ["已决定使用蓝色方案"],
      expected: false,
    },
  ];
  for (const example of examples) {
    const output = wrap(example.candidates);
    assert.equal(schemaValid(output), true, example.id);
    const accepted = validateVersionedCandidates(output, [
      source(example.text),
    ]);
    const labels = accepted.map(
      (x) => x.kind + (x.kind === "decision" ? ":" + x.basis : ""),
    );
    assert.equal(
      JSON.stringify(labels) === JSON.stringify(example.gold) &&
        (!example.goldClaims ||
          JSON.stringify(accepted.map((item) => item.claim)) ===
            JSON.stringify(example.goldClaims)),
      example.expected,
      example.id,
    );
  }
});
