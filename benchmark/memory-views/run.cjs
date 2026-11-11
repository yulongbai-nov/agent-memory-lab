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
const otherScope = { ...scope, project: "memory-view-other-project" };
const topic = "Harbor rehearsal";
const otherTopic = "Harbor production";
const arms = ["file", "structured", "graph"];
const baseUrl = "http://127.0.0.1:8080";
const later = "2026-01-01T12:30:00Z";
const earlier = "2026-01-01T09:10:00Z";
const promptVersion = "synthetic-memory-view-reader-v1";
const retrievalBudget = { topK: 3, contextBytes: 1900 };
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

async function seed(dir, retrievalCheck = false) {
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
  if (retrievalCheck) {
    messages.find((m) => m[0] === "task")[3] =
      "Prepare the checklist. It is still open.";
    const relation = messages.find((m) => m[0] === "relation");
    relation[1] = "codex";
    relation[3] =
      "The open checklist depends on the Harbor rehearsal slot, effective retrospectively from 10:05 UTC.";
    relation[4] = "12:40:00";
    messages.find((m) => m[0] === "move")[3] =
      "Effective at noon UTC, move the Harbor rehearsal to Wednesday.";
    messages.push([
      "repeat-move",
      "dsh",
      topic,
      "The confirmed Harbor rehearsal moved to Wednesday effective at noon UTC.",
      "12:25:00",
    ]);
  }
  const refs = new Map();
  const topics = new Map();
  if (retrievalCheck) {
    messages.push(
      [
        "availability",
        "dsh",
        topic,
        "Thursday is a possible rehearsal slot if the venue is free. No decision was made.",
        "11:55:00",
      ],
      [
        "draft",
        "codex",
        topic,
        "Draft action: prepare a checklist for the weekday slot. It is pending review.",
        "12:20:00",
      ],
      [
        "archive-note",
        "codex",
        topic,
        "The current rehearsal checklist is filed in the archive.",
        "12:25:00",
      ],
    );
  }
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
      knownAt: retrievalCheck ? "2026-01-01T12:45:00Z" : "2026-01-01T10:06:00Z",
      ...(retrievalCheck && { effectiveAt: "2026-01-01T10:05:00Z" }),
    },
  ];
  const foreignRows = [];
  if (retrievalCheck) {
    const source = { harness: "codex", instance: "fixture", session: "move" };
    const item = {
      id: "move",
      kind: "message",
      role: "user",
      text: "Current confirmed Harbor rehearsal is Friday. Prepare the checklist for that slot.",
      time: "2026-01-01T12:29:00Z",
      metadata: { topic },
    };
    await archive.importBatch({
      scope: otherScope,
      source,
      checkpoint: { position: 1 },
      items: [item],
    });
    const foreign = await archive.getItem({ ...otherScope, id: item.id });
    foreignRows.push({
      id: item.id,
      type: "source",
      topic,
      scope: otherScope,
      ref: handle({
        id: item.id,
        revision: foreign.versionId,
        source,
        scope: otherScope,
      }),
      harness: source.harness,
      time: item.time,
      text: item.text,
    });
  }
  return { archive, refs, topics, dependencies, foreignRows };
}
const handle = (ref) =>
  JSON.stringify([
    ref.scope?.owner ?? scope.owner,
    ref.scope?.project ?? scope.project,
    ref.source?.harness,
    ref.source?.instance,
    ref.source?.session,
    ref.id,
    ref.revision,
  ]);

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
      scope,
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
    scope,
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
    scope,
    topic: reviews.find((r) => r.id === d.taskId).topic,
    task: d.taskId,
    decision: d.decisionId,
    approved: d.approved,
    evidence: handle(d.evidence),
    effectiveAt: d.effectiveAt ?? null,
    knownAt: d.knownAt,
  }));
  return { op, sourceRows, reviewRows, relationRows };
}

async function buildViews(dir, fixture, corpus) {
  const { op, sourceRows, reviewRows, relationRows } = corpus;
  const all = [...sourceRows, ...reviewRows, ...relationRows];
  const byId = new Map(
    all.filter((row) => row.type !== "source").map((row) => [row.id, row]),
  );
  const byRef = new Map(sourceRows.map((row) => [row.ref, row]));
  const exactSource = (ref) => {
    const row = byRef.get(typeof ref === "string" ? ref : handle(ref));
    assert.ok(row, "Unknown exact source revision");
    return row;
  };
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
  await writeRows(journal, [...sourceRows, ...fixture.foreignRows]);
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
  if (fixture.dependencies[0].effectiveAt) {
    assert.equal(
      answerDependency({
        projection: graph,
        decisionRootId: "decision",
        mode: "current-known",
        knowledgeCutoff: "2026-01-01T12:30:00Z",
      }).tasks.length,
      0,
    );
    assert.equal(
      answerDependency({
        projection: graph,
        decisionRootId: "decision",
        mode: "current-known",
        knowledgeCutoff: "2026-01-01T13:00:00Z",
      }).tasks.length,
      1,
    );
    assert.equal(
      graph.corrections.find((row) => row.id === "clarification")
        .effectiveTimeKnown,
      false,
    );
  }

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
        .map((line) => JSON.parse(line.slice(2)))
        .filter((row) => row.topic === topic),
    structured: async () => {
      const page = await op.timeline({ topic, limit: 20 });
      assert.equal(page.coverage.has_more, false);
      const ids = page.rows
        .flatMap((row) => [row.review_id, ...row.annotations.map((a) => a.id)])
        .filter(Boolean);
      const reviewIds = new Set(ids);
      for (const relation of relationRows)
        if (reviewIds.has(relation.task) && reviewIds.has(relation.decision))
          ids.push(relation.id);
      const reviewRows = getRows(ids);
      const sources = page.rows.map((row) => exactSource(row.citation));
      for (const row of reviewRows)
        for (const ref of citedBy(row)) sources.push(exactSource(ref));
      return [
        ...reviewRows,
        ...new Map(sources.map((row) => [row.ref, row])).values(),
      ];
    },
    graph: () => {
      const scoped = new Set(
        graph.nodes
          .filter((node) => node.topic === topic)
          .map((node) => node.id),
      );
      const ids = [],
        sources = [];
      for (const edge of graph.edges) {
        if (!scoped.has(edge.to)) continue;
        ids.push(edge.from);
        if (edge.kind === "DEPENDS_ON") ids.push(edge.id);
        if (edge.evidence) sources.push(exactSource(edge.evidence));
      }
      for (const node of graph.nodes)
        if (scoped.has(node.id)) {
          ids.push(node.id);
          sources.push(exactSource(node.evidence));
        }
      const rows = getRows(ids);
      for (const row of rows)
        for (const ref of citedBy(row)) sources.push(exactSource(ref));
      return [
        ...rows,
        ...new Map(sources.map((row) => [row.ref, row])).values(),
      ];
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

function auditAnswer(output) {
  if (
    !output ||
    Object.keys(output).sort().join(",") !== "citations,facts,status" ||
    !schema.properties.status.enum.includes(output.status) ||
    !Array.isArray(output.facts) ||
    !output.facts.every((value) => typeof value === "string") ||
    !Array.isArray(output.citations) ||
    !output.citations.every((value) => typeof value === "string")
  )
    throw Error("Invalid structured answer");
  return {
    status: output.status,
    facts: output.facts,
    citations: output.citations,
  };
}

const stopWords = new Set(
  "a an and as at be by can each for from if in is it of on or return the their this that to was what when which with".split(
    " ",
  ),
);
const terms = (text) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2 && !stopWords.has(word)),
  );
const citedBy = (row) => [row.target, row.evidence].filter(Boolean);

function packEvidence(sources, records) {
  const handles = sources.map((source) => source.ref);
  return {
    sources: sources.map(({ ref, time, text, scope }) => ({
      ref,
      time,
      text,
      scope,
    })),
    reviews: records
      .filter(
        (row) =>
          citedBy(row).length &&
          citedBy(row).every((ref) => handles.includes(ref)),
      )
      .map((row) => ({
        scope: row.scope,
        id: row.id,
        type: row.type,
        ...(row.text != null && { text: row.text }),
        ...(row.target && { target: handles.indexOf(row.target) }),
        ...(row.evidence && { evidence: handles.indexOf(row.evidence) }),
        ...(row.revises && { revises: row.revises }),
        ...(row.task && { task: row.task }),
        ...(row.decision && { decision: row.decision }),
        ...(row.approved !== undefined && { approved: row.approved }),
        effectiveAt: row.effectiveAt ?? null,
        knownAt: row.knownAt ?? null,
        ...(row.basis && { basis: row.basis }),
        ...(row.lifecycle && { lifecycle: row.lifecycle }),
      })),
  };
}
function selectEvidence(
  question,
  rows,
  {
    scope: selectedScope = scope,
    topic: selectedTopic = topic,
    limits = retrievalBudget,
  } = {},
) {
  const words = terms(question.text);
  for (const word of terms(selectedTopic)) words.delete(word);
  const sources = rows.filter(
    (row) =>
      row.type === "source" &&
      row.scope?.owner === selectedScope.owner &&
      row.scope?.project === selectedScope.project,
  );
  const records = rows.filter(
    (row) =>
      row.type !== "source" &&
      row.scope?.owner === selectedScope.owner &&
      row.scope?.project === selectedScope.project,
  );
  const rank = (source) => {
    const attached = records.filter((row) => citedBy(row).includes(source.ref));
    const content = terms(
      [
        source.text,
        ...attached.flatMap((row) => [
          row.id,
          row.type,
          row.text ?? "",
          row.basis ?? "",
        ]),
      ].join(" "),
    );
    return [...words].filter((word) => content.has(word)).length;
  };
  // Stable ties retain the candidate ordering of the underlying view.
  const ranked = sources
    .map((source) => ({ source, score: rank(source) }))
    .sort(
      (a, b) => b.score - a.score || a.source.ref.localeCompare(b.source.ref),
    );
  const selected = [];
  const pack = (sources) => packEvidence(sources, records);
  for (const { source } of ranked) {
    if (selected.length === limits.topK) break;
    if (
      bytes(JSON.stringify(pack([...selected, source]))) <= limits.contextBytes
    )
      selected.push(source);
  }
  return pack(selected);
}

function relationAvailable(question, context, relationRef) {
  if (!["dependency-time", "dependency"].includes(question)) return true;
  return context.reviews.some(
    (row) =>
      row.type === "dependency" &&
      row.approved === true &&
      row.task === "checklist" &&
      row.decision === "decision" &&
      row.effectiveAt === "2026-01-01T10:05:00Z" &&
      row.knownAt === "2026-01-01T12:45:00Z" &&
      context.sources[row.evidence]?.ref === relationRef,
  );
}
function evaluate(oracle, id, output, context, refs) {
  const expected = oracle[id];
  if (!expected) throw Error("Unknown question");
  const citations =
    Array.isArray(output?.citations) &&
    output.citations.every((x) => typeof x === "string")
      ? output.citations
      : [];
  const provided = new Set(context.sources.map((row) => row.ref));
  const known = new Map([...refs].map(([key, value]) => [value, key]));
  const invalid = citations.filter(
    (ref) => !provided.has(ref) || !known.has(ref),
  );
  const irrelevant = citations.filter(
    (ref) => known.has(ref) && !expected.relevant.includes(known.get(ref)),
  );
  const facts =
    Array.isArray(output?.facts) &&
    output.facts.every((x) => typeof x === "string")
      ? output.facts.map(normalize)
      : null;
  const answerCorrect =
    output?.status === expected.status &&
    JSON.stringify(facts) === JSON.stringify(expected.facts.map(normalize));
  const supportCovered =
    expected.support.some((set) =>
      set.every((key) => citations.includes(refs.get(key))),
    ) && relationAvailable(id, context, refs.get("relation"));
  return {
    answerCorrect,
    supportCovered,
    invalidCitations: invalid.length,
    irrelevantCitations: irrelevant.length,
    pass:
      answerCorrect && supportCovered && !invalid.length && !irrelevant.length,
  };
}
async function runRetrievalCheck(fixture, views) {
  const foreignRef = fixture.foreignRows[0].ref;
  const lookup = async (ref, selectedScope) => {
    let parts;
    try {
      parts = JSON.parse(ref);
    } catch {
      return null;
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== 7 ||
      !parts.every((x) => typeof x === "string" && x)
    )
      return null;
    const [owner, project, harness, instance, session, id, revision] = parts;
    if (owner !== selectedScope.owner || project !== selectedScope.project)
      return null;
    const record = await fixture.archive.getItem({
      ...selectedScope,
      source: { harness, instance, session },
      id,
      revision,
    });
    return record &&
      record.item.id === id &&
      record.versionId === revision &&
      record.source.harness === harness &&
      record.source.instance === instance &&
      record.source.session === session &&
      record.scope.owner === selectedScope.owner &&
      record.scope.project === selectedScope.project
      ? record
      : null;
  };
  assert.ok(await lookup(foreignRef, otherScope));
  assert.equal(await lookup(foreignRef, scope), null);
  const auditReferences = async (refs) => {
    let wrongScope = 0,
      unresolved = 0;
    for (const ref of refs) {
      if (await lookup(ref, scope)) continue;
      if (await lookup(ref, otherScope)) wrongScope++;
      else unresolved++;
    }
    return { wrongScope, unresolved };
  };
  const staged = [];
  const prompts = require("./retrieval-spec.json");
  const retrievalArms = [...arms, "structured-bundle"];
  for (const question of prompts) {
    for (const arm of retrievalArms) {
      const start = performance.now();
      const rows =
        await views[arm === "structured-bundle" ? "structured" : arm]();
      const bundle =
        arm === "structured-bundle"
          ? require("./evidence-bundle.cjs").selectEvidenceBundle({
              scope,
              topic,
              request: question.request,
              rows,
              limits: retrievalBudget,
            })
          : null;
      const context = bundle ? bundle.context : selectEvidence(question, rows);
      const retrievalMs = round(performance.now() - start);
      const selectedRefs = context.sources.map((row) => row.ref);
      const referenced = [
        ...new Set([
          ...selectedRefs,
          ...context.reviews.flatMap((row) =>
            [row.target, row.evidence]
              .filter(Number.isInteger)
              .map((index) => selectedRefs[index]),
          ),
        ]),
      ];
      const audit = await auditReferences(referenced);
      const candidates = await auditReferences(
        new Set(
          rows.flatMap((row) => [row.ref, ...citedBy(row)].filter(Boolean)),
        ),
      );
      if (audit.wrongScope || audit.unresolved)
        throw Error("Unsafe evidence in reader context");
      staged.push({
        question: question.id,
        arm,
        rows,
        context,
        bundleStatus: bundle?.status ?? null,
        selectedRefs,
        referenced,
        audit,
        candidates,
        retrievalMs,
      });
    }
  }
  // The oracle is not loaded until all candidates and contexts have been fixed.
  const oracle = require("./retrieval-oracle.json");
  const mapped = new Map(
    [...fixture.refs].map(([id, ref]) => [id, handle(ref)]),
  );
  const results = staged.map(
    ({
      question,
      arm,
      rows,
      context,
      bundleStatus,
      selectedRefs,
      referenced,
      audit,
      candidates,
      retrievalMs,
    }) => {
      const acceptable = oracle[question].support.map((set) =>
        set.map((id) => mapped.get(id)),
      );
      const fullSupport =
        acceptable.some((set) =>
          set.every((ref) => selectedRefs.includes(ref)),
        ) && relationAvailable(question, context, mapped.get("relation"));
      const scopedRows = rows.filter(
        (row) =>
          row.scope?.owner === scope.owner &&
          row.scope?.project === scope.project,
      );
      const candidateSources = scopedRows.filter(
        (row) => row.type === "source",
      );
      const candidateContext = packEvidence(
        candidateSources,
        scopedRows.filter((row) => row.type !== "source"),
      );
      const candidateRefs = candidateSources.map((row) => row.ref);
      const candidateFullSupport =
        acceptable.some((set) =>
          set.every((ref) => candidateRefs.includes(ref)),
        ) &&
        relationAvailable(question, candidateContext, mapped.get("relation"));
      const contextBytes = bytes(JSON.stringify(context));
      assert.ok(
        selectedRefs.length <= retrievalBudget.topK &&
          contextBytes <= retrievalBudget.contextBytes,
      );
      return {
        question,
        arm,
        bundleStatus,
        candidateVersions: rows.filter((row) => row.type === "source").length,
        selectedRefs,
        candidateRefs: rows
          .filter((row) => row.type === "source")
          .map((row) => row.ref),
        candidateFullSupport,
        fullSupport,
        ...audit,
        candidateWrongScope: candidates.wrongScope,
        candidateUnresolved: candidates.unresolved,
        resolvedRefs: referenced.length - audit.wrongScope - audit.unresolved,
        contextBytes,
        retrievalMs,
      };
    },
  );
  for (const question of prompts.filter((item) => item.request)) {
    const result = results.find(
      (row) => row.question === question.id && row.arm === "structured-bundle",
    );
    assert.ok(
      result && result.bundleStatus === "complete" && result.fullSupport,
      `Typed bundle did not supply evidence: ${question.id}`,
    );
  }
  // Confirm the agreed budget is feasible without feeding oracle information into retrieval.
  const allRows = [...(await views.file())].filter(
    (row) => row.scope?.project === scope.project,
  );
  for (const question of prompts) {
    const sets = oracle[question.id].support;
    assert.ok(
      sets.some((set) => {
        const sources = allRows.filter(
          (row) => row.type === "source" && set.includes(row.id),
        );
        const handles = new Set(sources.map((row) => row.ref));
        const reviews = allRows.filter(
          (row) =>
            row.type !== "source" &&
            citedBy(row).length &&
            citedBy(row).every((ref) => handles.has(ref)),
        );
        return (
          sources.length === set.length &&
          bytes(JSON.stringify(packEvidence(sources, reviews))) <=
            retrievalBudget.contextBytes
        );
      }),
      `No valid support set fits budget: ${question.id}`,
    );
  }
  const contextFor = (ids) =>
    packEvidence(
      allRows.filter((row) => row.type === "source" && ids.includes(row.id)),
      allRows.filter((row) => row.type !== "source"),
    );
  const answer = (id, cites, context = contextFor(cites)) =>
    evaluate(
      oracle,
      id,
      {
        status: oracle[id].status,
        facts: oracle[id].facts,
        citations: cites.map((x) => mapped.get(x)),
      },
      context,
      mapped,
    );
  assert.ok(answer("dependency", ["task", "relation", "repeat-move"]).pass);
  assert.equal(answer("dependency", ["task", "move"]).pass, false);
  assert.equal(answer("dependency", ["task", "repeat-move"]).pass, false);
  assert.equal(
    answer("revision-kind", ["original", "clarify", "repeat-move"]).pass,
    false,
  );
  assert.ok(answer("revision-kind", ["original", "clarify", "move"]).pass);
  const relationContext = contextFor(["task", "relation", "repeat-move"]);
  assert.equal(
    answer("dependency", ["task", "relation", "repeat-move"], {
      sources: relationContext.sources,
      reviews: [],
    }).pass,
    false,
  );
  const clarification = contextFor(["clarify"]);
  assert.ok(
    evaluate(
      oracle,
      "historical",
      { status: "unknown", facts: [], citations: [mapped.get("clarify")] },
      clarification,
      mapped,
    ).pass,
  );
  assert.equal(
    evaluate(
      oracle,
      "historical",
      {
        status: "resolved",
        facts: ["Tuesday"],
        citations: [mapped.get("clarify")],
      },
      clarification,
      mapped,
    ).pass,
    false,
  );
  assert.equal(
    evaluate(
      oracle,
      "historical",
      { status: "unknown", facts: [], citations: [foreignRef] },
      clarification,
      mapped,
    ).pass,
    false,
  );
  assert.equal(
    evaluate(
      oracle,
      "historical",
      { status: "unknown", facts: [], citations: [mapped.get("original")] },
      clarification,
      mapped,
    ).pass,
    false,
  );
  const badRef = JSON.parse(mapped.get("clarify"));
  badRef[6] = "wrong-revision";
  assert.equal(
    evaluate(
      oracle,
      "historical",
      { status: "unknown", facts: [], citations: [JSON.stringify(badRef)] },
      clarification,
      mapped,
    ).pass,
    false,
  );

  return {
    fixture: "synthetic-memory-retrieval-v2",
    budget: retrievalBudget,
    crossScopeCollisionRejected: true,
    externalModelCalls: 0,
    results,
  };
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
        answer = null,
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
          if (status === "completed") {
            answer = auditAnswer(JSON.parse(text));
            assessment = grade(sample.question, answer, refs);
          }
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
        answer,
        expectedCitations: sample.question.refs.map((id) =>
          handle(refs.get(id)),
        ),
        ...assessment,
        answerMs: round(performance.now() - start),
      });
    }
    return { results, proxy: await stats() };
  } finally {
    child.kill();
  }
}

async function runFixture(mode) {
  const dir = await fs.mkdtemp(join(tmpdir(), "memory-view-comparison-"));
  try {
    const start = performance.now();
    const fixture = await seed(dir, mode === "--retrieval");
    const corpus = await makeCorpus(dir, fixture);
    const sharedBuildMs = round(performance.now() - start);
    const views = await buildViews(dir, fixture, corpus);
    if (mode === "--retrieval") {
      return {
        mode: "retrieval",
        sharedBuildMs,
        buildMs: views.buildMs,
        ...(await runRetrievalCheck(fixture, views)),
      };
    }
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
    const live = mode === "--live";
    const run = live
      ? await runReader(cases, fixture.refs)
      : { results: [], proxy: null };
    return {
      mode: live ? "live" : "dry",
      promptVersion,
      promptSha256: digest(instructions),
      questions: questions.map((q) => q.id),
      sharedBuildMs,
      buildMs: views.buildMs,
      retrieval,
      ...run,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function checkRetrieval() {
  const first = await runFixture("--retrieval");
  const second = await runFixture("--retrieval");
  for (const trial of [first, second]) {
    assert.equal(trial.externalModelCalls, 0);
    assert.equal(trial.crossScopeCollisionRejected, true);
    assert.equal(
      trial.results.length,
      require("./retrieval-spec.json").length * (arms.length + 1),
    );
    for (const row of trial.results) {
      const label = `${row.arm}/${row.question}`;
      assert.equal(row.wrongScope, 0, `Cross-project evidence in ${label}`);
      assert.equal(
        row.candidateUnresolved + row.unresolved,
        0,
        `Unresolved revision in ${label}`,
      );
      assert.ok(
        (row.selectedRefs.length > 0 ||
          row.bundleStatus === "unknown" ||
          row.bundleStatus === "insufficient") &&
          row.selectedRefs.length <= trial.budget.topK,
        `Invalid topK in ${label}`,
      );
      assert.equal(
        row.resolvedRefs,
        row.selectedRefs.length,
        `Duplicate or unresolved citation in ${label}`,
      );
      assert.ok(
        row.contextBytes <= trial.budget.contextBytes,
        `Context budget exceeded in ${label}`,
      );
    }
  }
  const stable = (trial) =>
    trial.results.map((row) => ({ ...row, retrievalMs: null }));
  assert.deepEqual(
    stable(first),
    stable(second),
    "Fresh fixtures produced different retrieval results",
  );
  return {
    fixture: first.fixture,
    cases: first.results.length,
    repetitions: 2,
    budget: first.budget,
    scope: "passed",
    exactReferences: "passed",
    determinism: "passed",
    externalModelCalls: 0,
  };
}

async function main() {
  const mode = process.argv[2];
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 &&
        ["--live", "--retrieval", "--check-retrieval"].includes(mode)),
    "Use default dry run, --retrieval, --check-retrieval, or separately authorized --live",
  );
  const result =
    mode === "--check-retrieval"
      ? await checkRetrieval()
      : await runFixture(mode);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { selectEvidence };
