'use strict';

function versionSummary(record) {
  const { item, versionId } = record;
  const pendingReview = typeof item.text === 'string' && item.text.length > 0 &&
    item.role === 'user' && !item.metadata?.reviewed;
  return {versionId, pendingReview, previewBytes: pendingReview ? Buffer.byteLength(item.text) : 0};
}

function semanticQueueFromSummaries(summaries) {
  const eligible = summaries.filter(record => record.pendingReview);
  return {
    pending: eligible.map(record => record.versionId).sort(),
    stats: {
      semanticStatus: 'requires-user-consent',
      semanticItemsPending: eligible.length,
      previewBytes: eligible.reduce((bytes, record) => bytes + record.previewBytes, 0),
      modelCalls: 0
    }
  };
}

const semanticQueue = records => semanticQueueFromSummaries(records.map(versionSummary));

module.exports = { semanticQueue, semanticQueueFromSummaries, versionSummary };
