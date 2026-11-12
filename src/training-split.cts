import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  buildTrainingManifest,
  type EvidenceRef,
  type Label,
  type Purpose,
} from "./training-manifest.cjs";

export type ExportSplit = "train" | "test";
export interface SplitEvidence {
  ref: EvidenceRef;
  excerpt: string;
}
export interface SplitEvidenceProvenance {
  ref: EvidenceRef;
  contentHash: string;
  authorizationId: string;
  purpose: Purpose;
  sourceSessionId?: string;
}
export interface SplitSample {
  id: string;
  input: { query: string; evidence: SplitEvidence[] };
  expected: {
    answer: string;
    labels: Label[];
    validTime?: string;
    observedTime?: string;
  };
}
export interface TrainingSplit {
  version: "training-split-v1";
  split: ExportSplit;
  sourceManifestHash: string;
  evidenceRegistry: SplitEvidenceProvenance[];
  samples: SplitSample[];
  contentHash: string;
}

const refFields = [
  "owner",
  "project",
  "harness",
  "instance",
  "session",
  "entry",
  "revision",
] as const;
const key = (ref: EvidenceRef): string =>
  JSON.stringify(refFields.map((field) => ref[field]));

/** Validate the complete parent before producing an isolated, model-ready split. */
export function exportTrainingSplit(
  manifest: unknown,
  split: unknown,
): TrainingSplit {
  if (split !== "train" && split !== "test")
    throw new Error("split must be train or test");
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  )
    throw new Error("manifest must be an object");
  const parent = manifest as Record<string, unknown>;
  if (
    Object.keys(parent).some(
      (field) =>
        !["version", "registry", "grants", "samples", "contentHash"].includes(
          field,
        ),
    ) ||
    parent.version !== "training-manifest-v1"
  )
    throw new Error("invalid training manifest");
  const validated = buildTrainingManifest({
    registry: parent.registry,
    grants: parent.grants,
    samples: parent.samples,
  });
  // Reject dropped entries as well as altered hashes and noncanonical manifests.
  if (!isDeepStrictEqual(parent, validated))
    throw new Error(
      "training manifest content hash or canonical content mismatch",
    );
  const registry = new Map(
    validated.registry.map((entry) => [key(entry), entry]),
  );
  const grants = new Map(
    validated.grants.map((grant) => [
      JSON.stringify([key(grant), grant.purpose]),
      grant,
    ]),
  );
  const used = new Map<string, SplitEvidenceProvenance>();
  const samples: SplitSample[] = validated.samples
    .filter((sample) => sample.split === split)
    .map((sample) => {
      const evidence = sample.evidence.map((ref): SplitEvidence => {
        const entry = registry.get(key(ref));
        const grant = grants.get(JSON.stringify([key(ref), sample.purpose]));
        if (
          entry?.excerpt === undefined ||
          grant?.authorizationId === undefined
        )
          throw new Error(
            "split evidence requires excerpt and authorizationId",
          );
        used.set(key(ref), {
          ref,
          contentHash: entry.contentHash,
          authorizationId: grant.authorizationId,
          purpose: grant.purpose,
          ...(entry.sourceSessionId === undefined
            ? {}
            : { sourceSessionId: entry.sourceSessionId }),
        });
        return { ref, excerpt: entry.excerpt };
      });
      const expected: SplitSample["expected"] = {
        answer: sample.expected,
        labels: sample.labels,
      };
      if (sample.validTime !== undefined) expected.validTime = sample.validTime;
      if (sample.observedTime !== undefined)
        expected.observedTime = sample.observedTime;
      return {
        id: sample.id,
        input: { query: sample.query, evidence },
        expected,
      };
    });
  if (samples.length === 0) throw new Error("requested split has no samples");
  const body: Omit<TrainingSplit, "contentHash"> = {
    version: "training-split-v1",
    split,
    sourceManifestHash: validated.contentHash,
    evidenceRegistry: validated.registry.flatMap((entry) => {
      const provenance = used.get(key(entry));
      return provenance === undefined ? [] : [provenance];
    }),
    samples,
  };
  return {
    ...body,
    contentHash: `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`,
  };
}
