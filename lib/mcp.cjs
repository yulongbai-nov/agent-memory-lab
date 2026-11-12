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

function boundedTimeline(result) {
  let remaining=4096;
  return {...result,rows:result.rows.map(row=>{
    if(!row.task_state)return row;
    const {state,label,heads}=row.task_state,kept=[];
    for(const head of heads){
      if(kept.length>=3)break;
      if(typeof head.id!=='string'||head.id.length>1000||typeof head.recordedAt!=='string'||head.recordedAt.length>40||!['source','operator'].includes(head.evidenceKind))continue;
      const evidence=head.evidenceKind==='operator'?null:head.evidence;
      if(head.evidenceKind==='source' && (!evidence || typeof evidence.id!=='string' || evidence.id.length>1000 || typeof evidence.revision!=='string' || evidence.revision.length>1000 || !evidence.source))continue;
      const occurredAt=head.occurredAt??null;if(occurredAt!==null && (typeof occurredAt!=='string'||occurredAt.length>40))continue;
      const item={id:head.id,evidenceKind:head.evidenceKind,recordedAt:head.recordedAt,occurredAt,evidence};
      const size=Buffer.byteLength(JSON.stringify(item))+1;if(size>remaining)continue;
      remaining-=size;kept.push(item);
    }
    const truncated=kept.length<heads.length;
    return {...row,task_state:{view:"current-known",state,label,headCount:heads.length,heads:kept,truncated,...(truncated?{details:'本机 task-list 或 timeline'}:{})}};
  })};
}
async function startMcp(op, { allowAnnotations = false, findTool, timelineTool, evidenceTool } = {}) {
  const server = new Server({ name: 'agent-memory-lab', version: '0.1.0' }, { capabilities: { tools: {} } });
  const filters = { keyword: string, from: date, to: date, offset: integer, limit: integer };
  const routes = [
    ['memory_find', 'Find bounded topic candidates in the configured private project.', filters, [], op.find],
    ['memory_timeline', 'Show the timeline of a selected topic with source citations.', { ...filters, topic: string }, ['topic'], async args => boundedTimeline(await op.timeline(args))],
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
    { id: string, target: citation, evidence: citation, kind: { enum: ['note', 'correction', 'change', 'decision', 'todo'] }, text: { type: 'string', maxLength: 4000 }, topic: string, basis: { enum: ['confirmed', 'proposed', 'uncertain'] }, lifecycle: { enum: ['active', 'superseded', 'cancelled'] }, revises: string, valid_time: date },
    ['id', 'target', 'kind', 'text'], op.annotate
  ]);
  const Ajv = require('ajv');
  const ajv = new Ajv();
  const overrides = { memory_find: findTool, memory_timeline: timelineTool, memory_evidence: evidenceTool };
  const catalog = new Map(routes.map(([name, description, properties, required, run]) => {
    const override = overrides[name];
    if (override) {
      return [name, {
        tool: { name, description: override.description, inputSchema: override.inputSchema },
        validate: () => true,
        run: override.run
      }];
    }
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
      if (request.params.name === 'memory_annotate' && error?.code === 'CORRECTION_EFFECTIVE_TIME') return failure(error.message);
      return failure('Memory operation failed for this scope or citation.');
    }
  });
  return server.connect(new StdioServerTransport());
}

function failure(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

module.exports = { startMcp, boundedTimeline };
