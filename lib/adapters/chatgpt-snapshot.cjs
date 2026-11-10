"use strict";
const { readChatgptSnapshot } = require("../generated/chatgpt-snapshot.cjs");
const { sourceIdentity } = require("./index.js");
const { checkpointRevision } = require("../checkpoint.cjs");

module.exports = {
  readChatgptSnapshot: (options) =>
    readChatgptSnapshot(options, { sourceIdentity, checkpointRevision }),
};
