"use strict";

// Run after `npm ci --ignore-scripts && npm run build`:
// node benchmark/graph-wiki/run-temporal-baseline.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { openArchive } = require("../../lib/archive.cjs");
const { originalCapture } = require("../../lib/originals.cjs");
const { createQuery } = require("../../lib/query.cjs");
const {
  rebuildProjection,
  answerDependency,
} = require("../../lib/ontology-projection.cjs");
const scenario = require("./scenario.json");

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moonbridge-temporal-"));
  let archive;
  try {
    const started = performance.now();
    archive = await openArchive({ dir });
    for (const original of scenario.fixture.originals) {
      const reference = scenario.references[original.ref];
      const item = scenario.fixture.batches
        .filter(
          (batch) =>
            batch.scope.owner === reference.scope.owner &&
            batch.scope.project === reference.scope.project &&
            batch.source.harness === reference.source.harness &&
            batch.source.instance === reference.source.instance &&
            batch.source.session === reference.source.session,
        )
        .flatMap((batch) => batch.items)
        .find((row) => row.id === reference.id && row.metadata?.original);
      assert.ok(item, `missing original metadata for ${original.ref}`);
      const captured = await originalCapture(dir)({
        bytes: Buffer.from(original.utf8),
        coordinate: item.metadata.original.coordinate,
      });
      assert.deepEqual(captured, item.metadata.original);
    }
    for (const batch of scenario.fixture.batches)
      await archive.importBatch(batch);
    for (const annotation of scenario.fixture.annotations)
      await archive.addAnnotation(annotation);
    const seedMs = performance.now() - started;
    const query = createQuery(archive);
    const boundary = scenario.queries.find(
      (q) => q.id === "effective-boundary",
    ).request;
    const queryStarted = performance.now();
    const decisions = [];
    for (const asOf of boundary.validTimes) {
      const rows = await query.current({
        ...scenario.scope,
        topic: boundary.topic,
        asOf,
      });
      assert.equal(rows.length, 1);
      decisions.push({
        asOf,
        reviewId: rows[0].review_id,
        text: rows[0].text,
        citation: rows[0].citation,
      });
    }
    assert.deepEqual(
      decisions.map((row) => row.reviewId),
      scenario.expected["effective-boundary"].facts,
    );
    const evidence = {};
    for (const [alias, expectation, decision] of [
      ["original", "old-evidence", decisions[0]],
      ["move", "change-evidence", decisions[1]],
    ]) {
      const { scope, ...reference } = scenario.references[alias];
      assert.deepEqual(decision.citation, reference);
      const row = await query.evidence({ ...scope, ...decision.citation });
      assert.equal(row.id, reference.id);
      assert.equal(row.revision, reference.revision);
      assert.deepEqual(row.source, reference.source);
      assert.deepEqual(row.scope, scope);
      assert.equal(
        row.turnId,
        scenario.expected[expectation].assertions.turnId,
      );
      assert.equal(
        row.original.availability,
        scenario.expected[expectation].assertions.originalAvailability,
      );
      evidence[alias] = {
        scope: row.scope,
        id: row.id,
        revision: row.revision,
        source: row.source,
        turnId: row.turnId,
        availability: row.original.availability,
      };
    }
    const dependencyRequest = scenario.queries.find(
      (q) => q.id === "dependency-time",
    ).request;
    const projection = await rebuildProjection({
      archive,
      scope: scenario.scope,
      asOf: dependencyRequest.asOf,
      dependencies: scenario.fixture.dependencies,
    });
    const correction = projection.corrections.find(
      (row) => row.id === "route-correction",
    );
    assert.ok(correction);
    assert.equal(correction.effectiveTimeKnown, false);
    const edge = projection.edges.find((row) => row.kind === "DEPENDS_ON");
    assert.ok(edge);
    assert.equal(
      edge.effectiveAt,
      scenario.expected["dependency-time"].assertions.effectiveAt,
    );
    assert.equal(
      edge.knownAt,
      scenario.expected["dependency-time"].assertions.knownAt,
    );
    const dependencies = dependencyRequest.knowledgeCutoffs.map(
      (knowledgeCutoff) => {
        const result = answerDependency({
          projection,
          decisionRootId: dependencyRequest.decisionRootId,
          mode: "current-known",
          knowledgeCutoff,
        });
        assert.equal(result.status, "resolved");
        return {
          knowledgeCutoff,
          presence: result.tasks.length ? "present" : "absent",
          tasks: result.tasks,
        };
      },
    );
    assert.deepEqual(
      dependencies.map((row) => row.presence),
      scenario.expected["dependency-time"].facts,
    );
    const queryMs = performance.now() - queryStarted;
    console.log(
      JSON.stringify(
        {
          scenario: "Moonbridge",
          status: "passed",
          decisions,
          correctionHistoricalTime: "unknown",
          evidence,
          dependency: {
            asOf: dependencyRequest.asOf,
            effectiveAt: edge.effectiveAt,
            knownAt: edge.knownAt,
            comparisons: dependencies,
          },
          timingMs: { seed: seedMs, queryAndProjection: queryMs },
          limitations: [
            "Synthetic local scenario; no model or external service.",
            "Decision query is retrospective and applies the correction whose historical effective time is unknown.",
            "Timings are single-run observations, not a performance benchmark.",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await archive?.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
