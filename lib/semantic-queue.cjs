'use strict';

function semanticQueue(records) {
  const eligible = records.filter(({ item }) => item.text && item.role === 'user' && !item.metadata?.reviewed);
  return {
    pending: eligible.map(record => record.versionId).sort(),
    stats: {
      semanticStatus: 'requires-user-consent',
      semanticItemsPending: eligible.length,
      previewBytes: eligible.reduce((bytes, { item }) => bytes + Buffer.byteLength(item.text), 0),
      modelCalls: 0
    }
  };
}

module.exports = { semanticQueue };
