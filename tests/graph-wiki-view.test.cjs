"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { graphWikiView } = require("../lib/generated/graph-wiki-view.cjs");
test("confirmed chain survives filtering and task labels stay distinct", () => {
  const citation = {
    id: "source",
    revision: "v1",
    source: { harness: "dsh", instance: "fixture", session: "s" },
  };
  const row = (id, kind, revises, label = "已确定") => ({
    review_id: id,
    kind,
    revises,
    label,
    citation,
    text: id,
    time: "2026-01-01T00:00:00Z",
  });
  const a = row("a", "decision", []),
    b = row("b", "change", "a"),
    c = row("c", "change", "b");
  const task = {
    ...row("task", "todo", []),
    task_state: { state: "paused", label: "已暂停" },
  };
  const result = graphWikiView(
    [a, b, c, task],
    [{ review_id: "c", label: "已确定" }],
    [a, b, task],
  );
  assert.deepEqual(
    result.rows.map((r) => r.label),
    ["已替代", "已替代", "任务 · 已暂停"],
  );
  const uncertain = row("a", "decision", [], "待核实");
  assert.equal(
    graphWikiView([uncertain, b], [{ review_id: "b", label: "已确定" }]).rows[0]
      .label,
    "待核实",
  );
});
