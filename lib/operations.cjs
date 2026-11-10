'use strict';

const { homedir } = require('node:os');
const { join } = require('node:path');
const { openArchive } = require('./archive.cjs');
const { createQuery } = require('./query.cjs');

function profile(options = {}) {
  const dir = options.dir || process.env.MEMORY_LAB_DIR || join(homedir(), '.local', 'share', 'agent-memory-lab');
  const owner = options.owner || process.env.MEMORY_LAB_OWNER || 'local';
  const project = options.project || process.env.MEMORY_LAB_PROJECT;
  if (!project) throw new Error('Select a project with --project or MEMORY_LAB_PROJECT.');
  return { dir, owner, project };
}

async function operations(options) {
  const { dir, owner, project } = profile(options);
  const scope = { owner, project };
  const archive = await openArchive({ dir, readOnly: options.readOnly === true });
  const query = createQuery(archive);
  const allowedFields = ['keyword', 'from', 'to', 'limit', 'id', 'revision', 'versionId', 'harness', 'instance', 'session', 'topic', 'offset', 'source', 'asOf'];
  function lookup(args = {}) {
    const selection = Object.fromEntries(allowedFields.filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    return { ...selection, ...scope };
  }
  return {
    dir, scope, archive,
    async find(args) {
      const result = await query.find(lookup(args));
      return { ...result, topics: result.topics.map(topic => ({ ...topic, citations: topic.citations.slice(0, 3) })) };
    },
    async timeline(args) {
      const filters = lookup(args);
      const rows = await query.timeline(filters);
      const offset = Math.max(0, filters.offset || 0);
      const limit = Math.min(50, Math.max(1, filters.limit || 20));
      return {
        rows: rows.slice(offset, offset + limit).map(row => ({
          ...row, text: row.text.slice(0, 1000),
          annotations: row.annotations.slice(0, 10).map(note => ({ ...note, text: note.text.slice(0, 1000) }))
        })),
        coverage: { total: rows.length, offset, has_more: rows.length > offset + limit }
      };
    },
    current: args => query.current(lookup(args)),
    evidence: args => query.evidence(lookup(args)),
    coverage: () => archive.listSources(scope),
    annotate: ({ target, text, kind, id, ...fields }) =>
      query.annotate({ ...fields, scope, ...scope, id, target, text, kind })
  };
}

module.exports = { operations, profile };
