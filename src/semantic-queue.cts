"use strict";

interface VersionRecord {
  item: { text?: string; role?: string; metadata?: { reviewed?: unknown } };
  versionId: string;
}
interface Summary {
  versionId: string;
  pendingReview: boolean;
  previewBytes: number;
}

function versionSummary(record: VersionRecord): Summary {
  const { item, versionId } = record;
  const pendingReview =
    typeof item.text === "string" &&
    item.text.length > 0 &&
    item.role === "user" &&
    !item.metadata?.reviewed;
  return {
    versionId,
    pendingReview,
    previewBytes: pendingReview ? Buffer.byteLength(item.text ?? "") : 0,
  };
}

function semanticQueueFromSummaries(summaries: Summary[]) {
  const eligible = summaries.filter((record) => record.pendingReview);
  return {
    pending: eligible.map((record) => record.versionId).sort(),
    stats: {
      semanticStatus: "requires-user-consent",
      semanticItemsPending: eligible.length,
      previewBytes: eligible.reduce(
        (bytes, record) => bytes + record.previewBytes,
        0,
      ),
      modelCalls: 0,
    },
  };
}

const semanticQueue = (records: VersionRecord[]) =>
  semanticQueueFromSummaries(records.map(versionSummary));

module.exports = { semanticQueue, semanticQueueFromSummaries, versionSummary };
