import { Ajv } from "ajv";

type TimelineArguments = { topic: string };
type EvidenceArguments = { id: string; revision: string };
type Access<T> = (args: T) => boolean;
type Lookup<T, Result> = (args: T) => Result | Promise<Result>;

const timelineSchema = {
  type: "object",
  properties: { topic: { type: "string" } },
  required: ["topic"],
  additionalProperties: false,
};
const evidenceSchema = {
  type: "object",
  properties: { id: { type: "string" }, revision: { type: "string" } },
  required: ["id", "revision"],
  additionalProperties: false,
};
const ajv = new Ajv({ ownProperties: true });
const validateTimeline = ajv.compile<TimelineArguments>(timelineSchema);
const validateEvidence = ajv.compile<EvidenceArguments>(evidenceSchema);

function readTool<T, Result>(
  description: string,
  inputSchema: typeof timelineSchema | typeof evidenceSchema,
  validate: (args: unknown) => args is T,
  issued: Access<T>,
  unissuedCode: "topic-not-issued" | "citation-not-issued",
  lookup: Lookup<T, Result>,
) {
  return {
    description,
    inputSchema,
    async run(args: unknown) {
      if (!validate(args)) {
        return { error: { code: "invalid-arguments" as const } };
      }
      try {
        if (!issued(args)) return { error: { code: unissuedCode } };
        return await lookup(args);
      } catch {
        return { error: { code: "lookup-failed" as const } };
      }
    },
  };
}

function createBoundedTimeline<Result>(
  issued: Access<TimelineArguments>,
  lookup: Lookup<TimelineArguments, Result>,
) {
  return readTool(
    "Read the fixed timeline for an exact topic alias already returned by memory_find. The topic string is required. Paging and filters are unavailable.",
    timelineSchema,
    validateTimeline,
    issued,
    "topic-not-issued",
    lookup,
  );
}

function createBoundedEvidence<Result>(
  issued: Access<EvidenceArguments>,
  lookup: Lookup<EvidenceArguments, Result>,
) {
  return readTool(
    "Read one verified excerpt for the exact id and revision pair already returned by memory_timeline. Both strings are required.",
    evidenceSchema,
    validateEvidence,
    issued,
    "citation-not-issued",
    lookup,
  );
}

export { createBoundedEvidence, createBoundedTimeline };
