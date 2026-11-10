'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const string = { type: 'string', maxLength: 1000 };
const date = { type: 'string', maxLength: 40 };
const integer = { type: 'integer', minimum: 0, maximum: 10000 };
const citation = {
  type: 'object', additionalProperties: false, required: ['id', 'revision'],
  properties: { id: string, revision: string, source: { type: 'object' } }
};

async function startMcp(op, { allowAnnotations = false } = {}) {
  const server = new Server({ name: 'agent-memory-lab', version: '0.1.0' }, { capabilities: { tools: {} } });
  const filters = { keyword: string, from: date, to: date, offset: integer, limit: integer };
  const routes = [
    ['memory_find', 'Find bounded topic candidates in the configured private project.', filters, [], op.find],
    ['memory_timeline', 'Show the timeline of a selected topic with source citations.', { ...filters, topic: string }, ['topic'], op.timeline],
    ['memory_current', 'Read reviewed decisions and their status for a selected topic.', { topic: string }, ['topic'], op.current],
    ['memory_evidence', 'Read the exact archived version of an item after the user requests evidence.', citation.properties, citation.required, async args => {
      const result = await op.evidence(args);
      if (typeof result.text !== 'string' || result.text.length <= 4000) return result;
      return { ...result, text: result.text.slice(0, 4000), truncated: true };
    }],
    ['memory_coverage', 'List imported source ranges and known gaps.', {}, [], op.coverage]
  ];
  if (allowAnnotations) routes.push([
    'memory_annotate', 'Append a user-requested note or correction to an exact evidence citation.',
    { id: string, target: citation, kind: { enum: ['note', 'correction', 'change', 'decision', 'todo'] }, text: { type: 'string', maxLength: 4000 }, topic: string, basis: { enum: ['confirmed', 'proposed', 'uncertain'] }, lifecycle: { enum: ['active', 'superseded', 'cancelled'] }, revises: string, valid_time: date },
    ['id', 'target', 'kind', 'text'], op.annotate
  ]);
  const Ajv = require('ajv');
  const ajv = new Ajv();
  const catalog = new Map(routes.map(([name, description, properties, required, run]) => {
    const inputSchema = { type: 'object', properties, required, additionalProperties: false };
    return [name, { tool: { name, description, inputSchema }, validate: ajv.compile(inputSchema), run }];
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...catalog.values()].map(entry => entry.tool) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const route = catalog.get(request.params.name);
    const args = request.params.arguments ?? {};
    if (!route || !route.validate(args)) return failure('Unknown tool or invalid arguments.');
    try {
      const result = await route.run(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      if (error.code === 'CORRECTION_EFFECTIVE_TIME') return failure(error.message);
      return failure('Memory operation failed for this scope or citation.');
    }
  });
  return server.connect(new StdioServerTransport());
}

function failure(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

module.exports = { startMcp };
