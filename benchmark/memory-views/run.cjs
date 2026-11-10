"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { openArchive } = require("../../lib/archive.cjs");
const { operations } = require("../../lib/operations.cjs");
const {
  rebuildProjection,
  answerDependency,
} = require("../../lib/ontology-projection.cjs");
const { LIMITS } = require("../harness-e2e/openai-proxy.cjs");

const scope = { owner: "synthetic", project: "memory-view-comparison" };
const topic = "Harbor rehearsal";
const otherTopic = "Harbor production";
const arms = ["file", "structured", "graph"];
const baseUrl = "http://127.0.0.1:8080";
const later = "2026-01-01T12:30:00Z";
const earlier = "2026-01-01T09:10:00Z";
const promptVersion = "synthetic-memory-view-reader-v1";
const instructions = [
  "Answer only from the supplied synthetic memory rows. Rows can be in any order.",
  "A correction fixes an earlier interpretation. A change supersedes it at its stated valid time.",
  "Source message time does not prove when a review was recorded or known.",
  "If the requested fact cannot be determined, use status unknown and an empty facts array.",
  "Cite only exact source references from the rows. Cite the smallest sufficient set, even for an unknown answer.",
  "Return facts in the exact form and order requested by the question.",
].join(" ");
const questions = [
  {
    id: "current",
    text: `At ${later}, what day is the current confirmed Harbor rehearsal? Return the weekday as one fact.`,
    status: "resolved",
    facts: ["Wednesday"],
    refs: ["move"],
  },
  {
    id: "revision-kind",
    text: "For Harbor rehearsal, classify the clarification and the reschedule, in that order. Return two facts, each the review kind, and cite the original decision and the two later source messages.",
    status: "resolved",
    facts: ["correction", "change"],
    refs: ["original", "clarify", "move"],
  },
  {
    id: "dependency",
    text: `At ${later}, which open action depends on the selected Harbor rehearsal slot, and which weekday is that slot? Return the action text first and the weekday second. Cite the action, the dependency statement and the effective decision.`,
    status: "resolved",
    facts: ["Prepare the checklist.", "Wednesday"],
    refs: ["task", "relation", "move"],
  },
  {
    id: "historical",
    text: `Can the evidence establish the corrected Harbor rehearsal decision was already recorded or known at ${earlier}? Return status unknown if the review knowledge time cannot be established. If unknown, cite the source of the clarification.`,
    status: "unknown",
    facts: [],
    refs: ["clarify"],
  },
];
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "facts", "citations"],
  properties: {
    status: { type: "string", enum: ["resolved", "unknown"] },
    facts: { type: "array", items: { type: "string" } },
    citations: { type: "array", items: { type: "string" } },
  },
};
const bytes = (value) => Buffer.byteLength(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const round = (value) => Number(value.toFixed(2));

async function seed(dir) {
  const archive = await openArchive({ dir });
  const messages = [
    [
      "original",
      "dsh",
      topic,
      "Tuesday is the Harbor production slot.",
      "09:00:00",
    ],
    [
      "clarify",
      "dsh",
      topic,
      "Tuesday is the rehearsal, not production.",
      "09:05:00",
    ],
    ["task", "dsh", topic, "Prepare the checklist.", "10:00:00"],
    [
      "relation",
      "dsh",
      topic,
      "The checklist depends on the rehearsal slot.",
      "10:05:00",
    ],
    [
      "move",
      "codex",
      topic,
      "Move the Harbor rehearsal to Wednesday.",
      "12:00:00",
    ],
    [
      "distractor",
      "codex",
      otherTopic,
      "Harbor production stays on Thursday.",
      "12:15:00",
    ],
  ];
  const refs = new Map();
  const topics = new Map();
  for (const [id, harness, selectedTopic, text, time] of messages) {
    const source = { harness, instance: "fixture", session: id };
    await archive.importBatch({
      scope,
      source,
      checkpoint: { position: 1 },
      items: [
        {
          id,
          kind: "message",
          role: "user",
          text,
          time: `2026-01-01T${time}Z`,
          metadata: { topic: selectedTopic },
        },
      ],
    });
    const row = await archive.getItem({ ...scope, id });
    refs.set(id, { id, revision: row.versionId, source });
    topics.set(id, selectedTopic);
  }
  const reviews = [
    {
      id: "decision",
      kind: "decision",
      topic,
      text: "Tuesday production.",
      target: refs.get("original"),
    },
    {
      id: "clarification",
      kind: "correction",
      topic,
      text: "Tuesday rehearsal.",
      target: refs.get("original"),
      evidence: refs.get("clarify"),
      revises: "decision",
    },
    {
      id: "reschedule",
      kind: "change",
      topic,
      text: "Wednesday",
      target: refs.get("move"),
      revises: "decision",
      valid_time: "2026-01-01T12:00:00Z",
    },
    {
      id: "checklist",
      kind: "todo",
      topic,
      text: "Prepare the checklist.",
      target: refs.get("task"),
    },
    {
      id: "production",
      kind: "decision",
      topic: otherTopic,
      text: "Thursday",
      target: refs.get("distractor"),
    },
  ];
  for (const review of reviews)
    await archive.addAnnotation({ ...review, scope });
  const dependencies = [
    {
      id: "dependency",
      scope,
      approved: true,
      taskId: "checklist",
      decisionId: "decision",
      evidence: refs.get("relation"),
      knownAt: "2026-01-01T10:06:00Z",
    },
  ];
  return { archive, refs, topics, dependencies };
}
const handle = (ref) => `${ref.id}@${ref.revision}`;

async function makeCorpus(dir, fixture) {
  const op = await operations({ ...scope, dir, readOnly: true });
  const sourceRows = [];
  for (const ref of fixture.refs.values()) {
    const exact = await op.evidence(ref);
    assert.equal(exact.revision, ref.revision);
    assert.deepEqual(exact.source, ref.source);
    sourceRows.push({
      id: ref.id,
      type: "source",
      topic: fixture.topics.get(ref.id),
      ref: handle(ref),
      harness: exact.source.harness,
      time: exact.time,
      text: exact.text,
    });
  }
  const reviews = await fixture.archive.listAnnotations(scope);
  const reviewRows = reviews.map((review) => ({
    id: review.id,
    type: review.kind,
    topic: review.topic,
    text: review.text,
    target: handle(review.target),
    evidence: review.evidence ? handle(review.evidence) : null,
    revises: review.revises ?? null,
    effectiveAt: review.valid_time ?? null,
    knownAt: null,
    basis: review.basis ?? "confirmed",
    lifecycle: review.lifecycle ?? "active",
  }));
  const relationRows = fixture.dependencies.map((d) => ({
    id: d.id,
    type: "dependency",
    topic: reviews.find((r) => r.id === d.taskId).topic,
    task: d.taskId,
    decision: d.decisionId,
    approved: d.approved,
    evidence: handle(d.evidence),
    knownAt: d.knownAt,
  }));
  return { op, sourceRows, reviewRows, relationRows };
}

async function buildViews(dir, fixture, corpus) {
  const { op, sourceRows, reviewRows, relationRows } = corpus;
  const all = [...sourceRows, ...reviewRows, ...relationRows];
  const byId = new Map(all.map((row) => [row.id, row]));
  const buildMs = {};
  let start = performance.now();
  const journal = join(dir, "journal.md"),
    ledger = join(dir, "ledger.md");
  const writeRows = (file, rows) =>
    fs.writeFile(
      file,
      rows.map((row) => `- ${JSON.stringify(row)}\n`).join(""),
      { mode: 0o600 },
    );
  await writeRows(journal, sourceRows);
  await writeRows(ledger, [...reviewRows, ...relationRows]);
  buildMs.file = round(performance.now() - start);

  // No extra index is built here. Archive import is timed separately and shared.
  buildMs.structured = 0;
  start = performance.now();
  const graph = await rebuildProjection({
    archive: fixture.archive,
    scope,
    asOf: later,
    dependencies: fixture.dependencies,
  });
  buildMs.graph = round(performance.now() - start);
  const dependency = answerDependency({
    projection: graph,
    decisionRootId: "decision",
    mode: "current-known",
  });
  assert.equal(dependency.decision.text, "Wednesday");
  assert.equal(
    dependency.tasks[0].relationEvidence.revision,
    fixture.refs.get("relation").revision,
  );

  const getRows = (ids) =>
    [...new Set(ids)].map((id) => {
      const row = byId.get(id);
      assert.ok(row, "Unknown corpus row");
      return row;
    });
  return {
    buildMs,
    file: () =>
      execFileSync(
        "rg",
        [
          "--no-filename",
          "--threads",
          "1",
          "--fixed-strings",
          "--",
          `"topic":"${topic}"`,
          journal,
          ledger,
        ],
        { encoding: "utf8", timeout: 5000 },
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line.slice(2))),
    structured: async () => {
      const page = await op.timeline({ topic, limit: 20 });
      assert.equal(page.coverage.has_more, false);
      const ids = page.rows
        .flatMap((row) => [
          row.review_id,
          ...row.annotations.map((a) => a.id),
          row.citation.id,
        ])
        .filter(Boolean);
      const reviewIds = new Set(ids);
      for (const relation of relationRows) {
        if (reviewIds.has(relation.task) && reviewIds.has(relation.decision))
          ids.push(relation.id);
      }
      for (const id of [...ids]) {
        const row = byId.get(id);
        if (row?.evidence) ids.push(row.evidence.split("@", 1)[0]);
      }
      return getRows(ids);
    },
    graph: () => {
      const scoped = new Set(
        graph.nodes
          .filter((node) => node.topic === topic)
          .map((node) => node.id),
      );
      const ids = [];
      for (const edge of graph.edges) {
        if (!scoped.has(edge.to)) continue;
        if (edge.kind === "DEPENDS_ON") ids.push(edge.id, edge.from);
        else if (edge.kind === "CORRECTS") ids.push(edge.from);
        else ids.push(edge.from);
        if (edge.evidence) ids.push(edge.evidence.id);
      }
      for (const node of graph.nodes)
        if (scoped.has(node.id)) ids.push(node.id, node.evidence.id);
      return getRows(ids);
    },
  };
}

const normalize = (text) =>
  text
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?]+$/, "");
function grade(question, output, refs) {
  const wantedRefs = question.refs.map((id) => handle(refs.get(id))).sort();
  const wantedFacts = question.facts.map(normalize);
  const facts =
    Array.isArray(output?.facts) &&
    output.facts.every((fact) => typeof fact === "string")
      ? output.facts.map(normalize)
      : null;
  const citations =
    Array.isArray(output?.citations) &&
    output.citations.every((ref) => typeof ref === "string")
      ? [...output.citations].sort()
      : null;
  const answerCorrect =
    output?.status === question.status &&
    JSON.stringify(facts) === JSON.stringify(wantedFacts);
  const evidenceExact =
    JSON.stringify(citations) === JSON.stringify(wantedRefs);
  return { answerCorrect, evidenceExact, pass: answerCorrect && evidenceExact };
}

async function runReader(cases, refs) {
  const token = randomBytes(24).toString("hex");
  let diagnostic = "";
  const child = spawn(
    process.execPath,
    [join(__dirname, "../harness-e2e/openai-proxy.cjs"), "--local-env-file"],
    {
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        MEMLAB_PROXY_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  child.stdout.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-1024);
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const request = (route, options = {}) =>
    fetch(baseUrl + route, {
      ...options,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(LIMITS.requestMs + 3000),
    });
  const stats = async () => {
    const response = await request("/stats");
    if (!response.ok) throw Error("Local bounded proxy unavailable");
    return response.json();
  };
  try {
    for (
      let attempt = 0;
      attempt < 40 && !diagnostic.includes("ready");
      attempt++
    ) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      diagnostic.includes("ready"),
      "Local bounded proxy did not start",
    );
    assert.equal((await stats()).requests, 0);
    const results = [];
    for (const sample of cases) {
      const start = performance.now();
      let status = "failed",
        usage = null,
        model = null,
        assessment = null;
      try {
        const response = await request("/v1/responses", {
          method: "POST",
          body: sample.body,
        });
        if (!response.ok) {
          status = `http-${response.status}`;
          await response.body?.cancel();
        } else {
          const out = await response.json();
          model = /^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(out.model ?? "")
            ? out.model
            : null;
          usage = out.usage
            ? {
                input: out.usage.input_tokens,
                output: out.usage.output_tokens,
                cached: out.usage.input_tokens_details?.cached_tokens ?? null,
              }
            : null;
          const text = out.output
            ?.flatMap((item) => item.content ?? [])
            .find((item) => item.type === "output_text")?.text;
          status =
            out.status === "completed" && model && text
              ? "completed"
              : "unverified";
          if (status === "completed")
            assessment = grade(sample.question, JSON.parse(text), refs);
        }
      } catch {
        status = "response-error";
      }
      results.push({
        question: sample.question.id,
        arm: sample.arm,
        status,
        usage,
        model,
        ...assessment,
        answerMs: round(performance.now() - start),
      });
    }
    return { results, proxy: await stats() };
  } finally {
    child.kill();
  }
}

async function main() {
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === "--live"),
    "Use default dry run or --live",
  );
  const dir = await fs.mkdtemp(join(tmpdir(), "memory-view-comparison-"));
  try {
    const start = performance.now();
    const fixture = await seed(dir);
    const corpus = await makeCorpus(dir, fixture);
    const sharedBuildMs = round(performance.now() - start);
    const views = await buildViews(dir, fixture, corpus);
    const expected = [
      ...corpus.sourceRows,
      ...corpus.reviewRows,
      ...corpus.relationRows,
    ].filter((row) => row.topic === topic);
    const parity = (rows) =>
      JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());
    const cases = [];
    const retrieval = [];
    for (const [i, question] of questions.entries()) {
      // Rotate the ordering so each arm is not always first.
      for (const arm of [...arms.slice(i % 3), ...arms.slice(0, i % 3)]) {
        const before = performance.now();
        const rows = await views[arm]();
        const elapsed = performance.now() - before;
        assert.equal(
          parity(rows),
          parity(expected),
          `${arm} must expose exactly the same corpus rows`,
        );
        const input = JSON.stringify({
          question: question.text,
          evidence: rows,
        });
        const body = JSON.stringify({
          model: "gpt-6-luna",
          reasoning: { effort: "low" },
          instructions,
          input,
          stream: false,
          text: {
            format: {
              type: "json_schema",
              name: "memory_view_answer",
              strict: true,
              schema,
            },
          },
        });
        retrieval.push({
          question: question.id,
          arm,
          retrievalMs: round(elapsed),
          rows: rows.length,
          refs: rows.filter((row) => row.type === "source").length,
          inputBytes: bytes(input),
          requestBytes: bytes(body),
          evidenceSetSha256: digest(parity(rows)),
          evidenceOrderSha256: digest(JSON.stringify(rows)),
        });
        cases.push({ question, arm, body });
      }
    }
    assert.equal(cases.length, 12);
    assert.ok(
      cases.every((sample) => bytes(sample.body) <= LIMITS.requestBytes),
    );
    assert.ok(
      cases.reduce((total, sample) => total + bytes(sample.body), 0) <=
        LIMITS.totalBytes,
    );
    const live = process.argv[2] === "--live";
    const run = live
      ? await runReader(cases, fixture.refs)
      : { results: [], proxy: null };
    console.log(
      JSON.stringify(
        {
          mode: live ? "live" : "dry",
          promptVersion,
          promptSha256: digest(instructions),
          questions: questions.map((q) => q.id),
          sharedBuildMs,
          buildMs: views.buildMs,
          retrieval,
          ...run,
        },
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
