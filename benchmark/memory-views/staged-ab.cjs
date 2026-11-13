"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { openArchive, versionDigest } = require("../../lib/archive.cjs");
const { createQuery } = require("../../lib/query.cjs");
const { migrateJsonToSqlite } = require("../../lib/storage-sqlite.cjs");
const { compareBound } = require("../../lib/query-time.cjs");
const {
  packStaged,
} = require("../../lib/generated/staged-context-packing.cjs");
const {
  handle,
  packEvidence,
  rankEvidence,
  selectEvidence,
} = require("./run.cjs");
const fixture = require("./staged-fixture.cjs");

const { scope } = fixture;
const limits = { topK: 3, contextBytes: 1900 };
const topicsLimit = 5;
const serializedBytes = (x) => Buffer.byteLength(JSON.stringify(x));
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const round = (ms) => Number(ms.toFixed(3));
const sameScope = (s) =>
  s?.owner === scope.owner && s?.project === scope.project;
const scopedHandle = (ref) => handle({ ...ref, scope });
const unique = (values) => [...new Set(values)];

async function seed(archive) {
  const refs = new Map();
  for (const batch of [...fixture.batches, ...fixture.foreignBatches]) {
    await archive.importBatch(batch);
    if (sameScope(batch.scope))
      for (const item of batch.items) {
        refs.set(item.id, {
          id: item.id,
          revision: versionDigest({ scope, source: batch.source, item }),
          source: batch.source,
        });
      }
  }
  for (const annotation of fixture.makeAnnotations((id) => refs.get(id)))
    await archive.addAnnotation(annotation);
  return refs;
}

async function readTopic(query, topic) {
  const sources = [];
  let cursor;
  do {
    const page = await query.topicSources({ ...scope, topic, cursor });
    for (const row of page.rows) {
      const exact = await query.evidence({ ...scope, ...row.citation });
      assert.ok(sameScope(exact.scope));
      assert.deepEqual(exact.source, row.citation.source);
      assert.equal(exact.revision, row.citation.revision);
      sources.push({
        id: exact.id,
        type: "source",
        scope,
        ref: scopedHandle(row.citation),
        time: exact.time,
        text: exact.text,
      });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return sources;
}

function requiredEvidence(intent, reviewed, current, asOf) {
  if (intent === "source") return [];
  if (intent === "decision-at") {
    assert.ok(asOf);
    return unique(
      current
        .flatMap(
          (row) => row.candidates ?? [row.citation, row.effectiveCitation],
        )
        .filter(Boolean)
        .map(scopedHandle),
    );
  }
  const refs =
    intent === "task"
      ? reviewed
          .filter((row) => row.kind === "todo")
          .flatMap((row) => [
            row.citation,
            ...(row.task_state?.heads ?? []).map((head) => head.evidence),
          ])
      : reviewed
          .filter(
            (row) =>
              ["decision", "change"].includes(row.kind) &&
              row.label === "已确定",
          )
          .flatMap((row) => [
            row.citation,
            ...row.annotations.map((note) => note.evidence),
          ]);
  return unique(refs.filter(Boolean).map(scopedHandle));
}

function verifyContext(context, canonical) {
  assert.ok(context.sources.length <= limits.topK);
  assert.ok(serializedBytes(context) <= limits.contextBytes);
  const seen = new Set();
  for (const source of context.sources) {
    const original = canonical.get(source.ref);
    assert.ok(
      original && sameScope(source.scope) && !seen.has(source.ref),
      "invalid or repeated scoped exact reference",
    );
    seen.add(source.ref);
    if (source.excerpt) {
      const { startUtf16, endUtf16 } = source.excerpt;
      assert.ok(
        Number.isInteger(startUtf16) &&
          startUtf16 >= 0 &&
          endUtf16 > startUtf16 &&
          endUtf16 <= original.text.length,
      );
      assert.equal(source.text, original.text.slice(startUtf16, endUtf16));
      assert.ok(
        !/[\uD800-\uDBFF]$/u.test(source.text) &&
          !/^[\uDC00-\uDFFF]/u.test(source.text),
      );
    } else assert.equal(source.text, original.text);
  }
  for (const review of context.reviews) {
    for (const index of [review.target, review.evidence].filter(
      (v) => v !== undefined,
    )) {
      assert.ok(
        Number.isInteger(index) && index >= 0 && index < context.sources.length,
      );
    }
  }
}

function packReviewed(c, question, rows, options, reviewed, current) {
  const { ranked, records } = rankEvidence(question, rows, options);
  const requiredRefs = requiredEvidence(c.intent, reviewed, current, c.asOf);
  const ambiguous = current.some((row) => row.label === "待核实");
  if (c.intent.startsWith("decision-") && ambiguous && requiredRefs.length < 2)
    return {
      context: packEvidence([], []),
      gap: "incomplete-conflict-evidence",
    };
  return packStaged({
    ranked: ranked.map(({ source }) => source),
    requiredRefs,
    question: c.question,
    limits,
    render: (selected) => packEvidence(selected, records),
  });
}

function checkPackingGuards() {
  const ranked = [
    { ref: "a", text: "A" },
    { ref: "b", text: "B" },
  ];
  const input = {
    ranked,
    question: "Conflict",
    requiredRefs: ["a", "b"],
    limits,
    render: (sources) => ({ sources }),
  };
  for (const cap of [
    { ...limits, topK: 1 },
    { ...limits, contextBytes: 20 },
  ]) {
    const blocked = packStaged({ ...input, limits: cap });
    assert.equal(blocked.gap, "required-evidence-over-budget");
    assert.deepEqual(blocked.context.sources, []);
  }
  const missing = packStaged({ ...input, ranked: ranked.slice(0, 1) });
  assert.equal(missing.gap, "missing-required-evidence");
  assert.deepEqual(missing.context.sources, []);
  assert.throws(
    () => packStaged({ ...input, ranked: [...ranked, ranked[0]] }),
    /Duplicate/,
  );
  const ambiguous = packReviewed(
    { intent: "decision-at", asOf: "2026-01-01T00:00:00Z" },
    { text: "Conflict" },
    [],
    { scope, limits },
    [],
    [{ label: "待核实", candidates: [] }],
  );
  assert.equal(ambiguous.gap, "incomplete-conflict-evidence");
  assert.deepEqual(ambiguous.context.sources, []);
  return {
    atomicLimits: true,
    missingRequired: true,
    duplicateRefRejected: true,
    ambiguityWithoutSources: true,
  };
}

async function run() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "staged-packing-"));
  let archive;
  try {
    archive = await openArchive({ dir });
    const refs = await seed(archive);
    archive.close?.();
    await migrateJsonToSqlite({ dir });
    archive = await openArchive({ dir, readOnly: true });
    assert.equal(archive.backend, "sqlite");
    const query = createQuery(archive);
    const foreign = fixture.foreignBatches[0];
    const [foreignItem] = foreign.items;
    const foreignRevision = versionDigest({
      scope: foreign.scope,
      source: foreign.source,
      item: foreignItem,
    });
    await assert.rejects(
      query.evidence({
        ...scope,
        source: foreign.source,
        id: foreignItem.id,
        revision: foreignRevision,
      }),
      /evidence not found/,
    );
    const annotations = await archive.listAnnotations(scope);
    const results = [];
    for (const c of fixture.cases) {
      const started = performance.now();
      const { topics } = await query.find({
        ...scope,
        keyword: c.keyword,
        limit: topicsLimit,
      });
      const top5 = topics.map((hit) => hit.topic);
      const found = top5.includes(c.topic);
      const sources = found ? await readTopic(query, c.topic) : [];
      const canonical = new Map(sources.map((source) => [source.ref, source]));
      assert.equal(
        canonical.size,
        sources.length,
        "duplicate scoped source version",
      );
      const reviews = annotations
        .filter(
          (a) =>
            a.topic === c.topic ||
            (a.kind === "task-state" && canonical.has(scopedHandle(a.target))),
        )
        .map((a) => ({
          id: a.id,
          type: a.kind,
          scope,
          text: a.text,
          target: scopedHandle(a.target),
          evidence: a.evidence ? scopedHandle(a.evidence) : null,
          revises: a.revises,
          effectiveAt: a.valid_time,
          basis: a.basis ?? "confirmed",
          lifecycle: a.lifecycle ?? "active",
          state: a.state,
        }));
      const queryArgs = {
        ...scope,
        topic: c.topic,
        ...(c.asOf ? { asOf: c.asOf } : {}),
      };
      const reviewed = found ? await query.reviewedTimeline(queryArgs) : [];
      const current = found ? await query.current(queryArgs) : [];
      const retrievalMs = round(performance.now() - started);
      const rows = [...sources, ...reviews];
      const options = { scope, topic: c.topic, limits };
      const question = { text: c.question };
      const expected = new Set(
        c.requiredIds.map((id) => {
          assert.ok(refs.has(id), "unknown fixture expected source");
          return scopedHandle(refs.get(id));
        }),
      );
      const arms =
        results.length % 4 ? ["staged", "baseline"] : ["baseline", "staged"];
      for (const arm of arms) {
        const start = performance.now();
        let result;
        if (!found)
          result = { context: packEvidence([], []), gap: "topic-not-found" };
        else if (arm === "baseline")
          result = {
            context: selectEvidence(question, rows, options),
            gap: null,
          };
        else
          result = packReviewed(c, question, rows, options, reviewed, current);
        const { context, gap } = result;
        const packingMs = round(performance.now() - start);
        verifyContext(context, canonical);
        const included = context.sources.map((s) => s.ref);
        const state =
          c.intent === "task"
            ? reviewed.find((row) => row.task_state)?.task_state?.state
            : current[0]?.label;
        if (found && c.expectedState) assert.equal(state, c.expectedState);
        const support =
          found &&
          c.requiredIds.every((id) => {
            const source = context.sources.find(
              (source) => source.ref === scopedHandle(refs.get(id)),
            );
            const expectedText = c.requiredText?.[id];
            return (
              source && (!expectedText || source.text.includes(expectedText))
            );
          });
        results.push({
          id: c.id,
          arm,
          top5,
          found,
          state: state ?? null,
          candidateCount: sources.length,
          candidateSha256: digest(sources),
          expectedUnknown: Boolean(c.expectedUnknown),
          support,
          exact: support && included.length === expected.size,
          preservedConflict: c.expectedState === "待核实" ? support : null,
          conflictReviewRows:
            c.expectedState === "待核实"
              ? context.reviews.filter(
                  (row) =>
                    row.type === "decision" &&
                    row.basis === "confirmed" &&
                    row.lifecycle === "active",
                ).length
              : null,
          newerSources: c.asOf
            ? context.sources.filter(
                (source) => compareBound(source.time, c.asOf) === 1,
              ).length
            : null,
          excerptCount: context.sources.filter((s) => s.excerpt).length,
          missing: [...expected].filter((ref) => !included.includes(ref)),
          included,
          gap,
          contextBytes: serializedBytes(context),
          retrievalMs,
          packingMs,
        });
      }
    }
    const staged = results.filter((row) => row.arm === "staged");
    assert.ok(
      staged.some((row) => !row.found && !row.expectedUnknown),
      "fixture must expose a top-five miss",
    );
    assert.ok(
      staged.some((row) => row.excerptCount > 0 && row.support),
      "fixture must exercise exact excerpts",
    );
    assert.ok(
      staged.some(
        (row) => row.preservedConflict && row.conflictReviewRows === 2,
      ),
      "fixture must retain both conflicting reviews",
    );
    return {
      mode: "synthetic-staged-ab",
      externalModelCalls: 0,
      topicsLimit,
      limits,
      guards: { ...checkPackingGuards(), foreignVersionRejected: true },
      results,
    };
  } finally {
    archive?.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (require.main === module)
  run()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { run };
