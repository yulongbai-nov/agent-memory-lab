import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  buildTrainingManifest,
  type EvidenceRef,
  type Grant,
  type RegistryEntry,
} from "./training-manifest.cjs";

// Pinned public repository fixtures only. A changed fixture fails closed until reviewed.
const FIXTURES = [
  [
    "examples/synthetic.json",
    "96000a9459aac3bf702e8aa5a98adfc121d4acbd7baa692ab98ee26180b7ff86",
  ],
  [
    "examples/training-manifest/conflict.json",
    "94c3c348ec94fba6faa7acf04b2a1c314bfd66dd6e829daa0cc01cb6b0671f42",
  ],
  [
    "benchmark/graph-wiki/scenario.json",
    "35b974f75e0cbbaa5ba65b2578d7131e3a9df745f1d5cbb2359c6651edf155ce",
  ],
] as const;
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

type Ref = EvidenceRef;
type Demo = {
  sources: {
    harness: string;
    session_id: string;
    source_version: string;
    messages: { id: string; turn: number; text: string }[];
  }[];
};
type GraphRef = {
  scope: { owner: string; project: string };
  id: string;
  revision: string;
  source: { harness: string; instance: string; session: string };
};
type Conflict = {
  scope: { owner: string; project: string };
  source: {
    harness: string;
    instance: string;
    session: string;
    source_version: string;
  };
  messages: { id: string; text: string; valid_time: string }[];
};
type Graph = {
  references: Record<string, GraphRef>;
  fixture: {
    batches: {
      scope: GraphRef["scope"];
      source: GraphRef["source"];
      items: { id: string; [key: string]: unknown }[];
    }[];
  };
};
const { versionDigest } = createRequire(__filename)("../archive.cjs") as {
  versionDigest: (record: {
    scope: GraphRef["scope"];
    source: GraphRef["source"];
    item: Record<string, unknown>;
  }) => string;
};

export function buildSyntheticTrainingManifest(): unknown {
  const bytes = FIXTURES.map(([path, digest]) => {
    const data = readFileSync(resolve(__dirname, "../..", path));
    if (sha256(data) !== digest)
      throw new Error("Synthetic fixture digest mismatch");
    return data.toString("utf8");
  });
  // The exact bytes above are pinned; these types describe those committed bytes.
  const demo = JSON.parse(bytes[0]!) as Demo;
  const conflictCases = (JSON.parse(bytes[1]!) as { cases: Conflict[] }).cases;
  const graph = JSON.parse(bytes[2]!) as Graph;
  const registry: RegistryEntry[] = [];
  const grants: Grant[] = [];
  const demoSource = demo.sources[0]!;
  const demoRef = (id: string): Ref => ({
    owner: "synthetic-user",
    project: "demo",
    harness: demoSource.harness,
    instance: "fixture",
    session: demoSource.session_id,
    entry: id,
    revision: demoSource.source_version,
  });
  for (const message of demoSource.messages) {
    const ref = demoRef(message.id);
    registry.push({
      ...ref,
      contentHash: "sha256:" + sha256(JSON.stringify(message)),
      excerpt: message.text,
    });
    grants.push({
      ...ref,
      purpose: "training",
      authorizationId: "synthetic-fixture:" + FIXTURES[0][1],
    });
  }
  const conflictRef = (index: number, entry: string): Ref => {
    const conflict = conflictCases[index]!;
    return {
      ...conflict.scope,
      harness: conflict.source.harness,
      instance: conflict.source.instance,
      session: conflict.source.session,
      entry,
      revision: conflict.source.source_version,
    };
  };
  for (const [index, conflict] of conflictCases.entries()) {
    for (const message of conflict.messages) {
      const ref = conflictRef(index, message.id);
      registry.push({
        ...ref,
        contentHash: "sha256:" + sha256(JSON.stringify(message)),
        excerpt: message.text,
      });
      grants.push({
        ...ref,
        purpose: index === 0 ? "training" : "evaluation",
        authorizationId: "synthetic-fixture:" + FIXTURES[1][1],
      });
    }
  }
  const graphRef = (name: string): Ref => {
    const ref = graph.references[name]!;
    return {
      ...ref.scope,
      ...ref.source,
      entry: ref.id,
      revision: ref.revision,
    };
  };
  for (const name of [
    "original",
    "clarify",
    "task",
    "relation",
    "move",
    "proposal",
    "complete",
  ]) {
    const ref = graphRef(name);
    const items = graph.fixture.batches
      .filter(
        (batch) =>
          batch.scope.owner === ref.owner &&
          batch.scope.project === ref.project &&
          batch.source.harness === ref.harness &&
          batch.source.instance === ref.instance &&
          batch.source.session === ref.session,
      )
      .flatMap((batch) =>
        batch.items.filter(
          (item) =>
            item.id === ref.entry &&
            versionDigest({
              scope: batch.scope,
              source: batch.source,
              item,
            }) === ref.revision,
        ),
      );
    const item = items[0];
    if (items.length !== 1 || typeof item?.text !== "string")
      throw new Error("Synthetic graph revision missing or ambiguous");
    registry.push({
      ...ref,
      contentHash: "sha256:" + sha256(JSON.stringify(item)),
      excerpt: item.text,
    });
    grants.push({
      ...ref,
      purpose: "evaluation",
      authorizationId: "synthetic-fixture:" + FIXTURES[2][1],
    });
  }
  const samples = [
    {
      id: "demo-correction",
      query: "What corrected the mistaken interpretation?",
      expected: "The starting point meant a benchmark baseline.",
      purpose: "training",
      split: "train",
      labels: ["correction"],
      evidence: [demoRef("msg-002"), demoRef("msg-003")],
      validTime: "2026-01-01T10:03:00.000Z",
      observedTime: "2026-01-01T10:03:00.000Z",
    },
    {
      id: "demo-decision-change",
      query: "What was decided and what later changed?",
      expected: "The benchmark baseline was chosen, then its use was stopped.",
      purpose: "training",
      split: "train",
      labels: ["decision", "change"],
      evidence: [demoRef("msg-003"), demoRef("msg-004"), demoRef("msg-005")],
      validTime: "2026-01-02T10:00:00.000Z",
      observedTime: "2026-01-02T10:01:00.000Z",
    },
    {
      id: "demo-unresolved-conflict",
      query: "Which launch day was approved?",
      expected:
        "Unresolved: equally timed approved heads say Monday and Tuesday.",
      purpose: "training",
      split: "train",
      labels: ["conflict"],
      evidence: [conflictRef(0, "conflict-a"), conflictRef(0, "conflict-b")],
      validTime: "2026-02-01T10:00:00.000Z",
    },
    {
      id: "heldout-unresolved-conflict",
      query: "Where is the workshop confirmed?",
      expected:
        "Unresolved: equally timed confirmed heads say the library and the museum.",
      purpose: "evaluation",
      split: "test",
      labels: ["conflict"],
      evidence: [conflictRef(1, "heldout-a"), conflictRef(1, "heldout-b")],
      validTime: "2026-03-01T10:00:00.000Z",
    },
    {
      id: "graph-correction-change",
      query: "Which event corrected the original and which changed it?",
      expected:
        "The clarification corrected Tuesday to a dry run; the later decision moved the dry run to Wednesday.",
      purpose: "evaluation",
      split: "test",
      labels: ["decision", "correction", "change"],
      evidence: [graphRef("original"), graphRef("clarify"), graphRef("move")],
      validTime: "2026-04-07T12:00:00.000Z",
    },
    {
      id: "graph-dependency-time",
      query:
        "When did the checklist dependency take effect, and when was it known?",
      expected: "It took effect at 10:05 UTC and was known at 12:45 UTC.",
      purpose: "evaluation",
      split: "test",
      labels: ["task"],
      evidence: [graphRef("task"), graphRef("relation"), graphRef("move")],
      validTime: "2026-04-07T10:05:00.000Z",
      observedTime: "2026-04-07T12:45:00.000Z",
    },
    {
      id: "graph-task",
      query: "What happened to the route checklist task?",
      expected: "The checklist was printed and ready; the task was completed.",
      purpose: "evaluation",
      split: "test",
      labels: ["task"],
      evidence: [graphRef("task"), graphRef("relation"), graphRef("complete")],
    },
    {
      id: "graph-proposal-negative",
      query: "Did the Thursday proposal supersede the Wednesday decision?",
      expected:
        "No. Thursday is a proposal; Wednesday remains the confirmed change.",
      purpose: "evaluation",
      split: "test",
      labels: ["negative"],
      evidence: [graphRef("proposal"), graphRef("move")],
    },
    {
      id: "graph-historical-negative",
      query: "Can the archive establish when the correction became known?",
      expected: "The time when the correction became known is unknown.",
      purpose: "evaluation",
      split: "test",
      labels: ["negative"],
      evidence: [graphRef("original"), graphRef("clarify")],
    },
  ];
  return {
    fixtures: FIXTURES.map(([path, sha256]) => ({ path, sha256 })),
    manifest: buildTrainingManifest({ registry, grants, samples }),
  };
}
