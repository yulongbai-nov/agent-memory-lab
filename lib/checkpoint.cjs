'use strict';

const { digest } = require('./storage.cjs');

function checkpointRevision(checkpoint) {
  if (!checkpoint) return null;
  const { scope, source, position } = checkpoint;
  return digest({ scope, source, position });
}

module.exports = { checkpointRevision };
