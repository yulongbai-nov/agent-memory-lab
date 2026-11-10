import { Ajv, type ErrorObject } from "ajv";

const defaultLimit = 5;
const findSchema = {
  type: "object",
  properties: {
    keyword: { type: ["string", "null"], maxLength: 60 },
    limit: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
  },
  required: [],
  additionalProperties: false,
};

type FindArguments = { keyword?: string | null; limit?: number | null };
type Search = { keyword?: string; limit: number };
type Topic = { topic: string; matchCount: number };
type SearchResult = { topics: Topic[]; searchMayHaveMore: boolean };
type Lookup = (search: Search) => SearchResult | Promise<SearchResult>;
type ArgumentType =
  | "missing"
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "undefined"
  | "other";
type Constraint =
  | "arguments-type"
  | "additional-property"
  | "keyword-type"
  | "keyword-max-length"
  | "limit-type"
  | "limit-minimum"
  | "limit-maximum"
  | "invalid-arguments";
type Diagnostic = {
  keyword: {
    type: ArgumentType;
    empty?: boolean;
    characters?: number;
    utf8Bytes?: number;
  };
  limit: { type: ArgumentType; value?: number };
  constraint: Constraint | null;
  mcpDispatched: true;
  queryDispatched: boolean;
  effectiveLimit?: number;
  outcome: "found" | "empty" | "lookup-failed" | "rejected";
  count: number;
};

const validate = new Ajv({ ownProperties: true }).compile<FindArguments>(
  findSchema,
);

function argumentType(value: unknown, present: boolean): ArgumentType {
  if (!present) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  switch (type) {
    case "object":
    case "string":
    case "number":
    case "boolean":
    case "undefined":
      return type;
    default:
      return "other";
  }
}

function constraintFor(error: ErrorObject | undefined): Constraint {
  if (error?.keyword === "additionalProperties") return "additional-property";
  if (error?.instancePath === "/keyword") {
    return error.keyword === "maxLength"
      ? "keyword-max-length"
      : "keyword-type";
  }
  if (error?.instancePath === "/limit") {
    if (error.keyword === "minimum") return "limit-minimum";
    if (error.keyword === "maximum") return "limit-maximum";
    return "limit-type";
  }
  return error?.keyword === "type" ? "arguments-type" : "invalid-arguments";
}

function inspect(args: unknown): Diagnostic {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const keyword = Object.hasOwn(record, "keyword") ? record.keyword : undefined;
  const limit = Object.hasOwn(record, "limit") ? record.limit : undefined;
  return {
    keyword: {
      type: argumentType(keyword, Object.hasOwn(record, "keyword")),
      ...(typeof keyword === "string" && {
        empty: keyword.trim() === "",
        characters: [...keyword].length,
        utf8Bytes: Buffer.byteLength(keyword),
      }),
    },
    limit: {
      type: argumentType(limit, Object.hasOwn(record, "limit")),
      ...(typeof limit === "number" &&
        Number.isFinite(limit) && { value: limit }),
    },
    constraint: null,
    mcpDispatched: true,
    queryDispatched: false,
    outcome: "rejected",
    count: 0,
  };
}

function createBoundedFind(
  lookup: Lookup,
  report: (diagnostic: Diagnostic) => void,
) {
  const { keyword: keywordSchema, limit: limitSchema } = findSchema.properties;
  return {
    description:
      "Find topic aliases in the configured project. Missing, null, or blank keyword searches the project without a keyword. " +
      `Use up to ${keywordSchema.maxLength} Unicode characters. Missing or null limit defaults to ${defaultLimit}. ` +
      `Limits from ${limitSchema.minimum} to ${limitSchema.maximum} are accepted, with at most ${defaultLimit} results returned.`,
    inputSchema: findSchema,
    async run(args: unknown) {
      const diagnostic = inspect(args);
      if (!validate(args)) {
        diagnostic.constraint = constraintFor(validate.errors?.[0]);
        report(diagnostic);
        return {
          topics: [],
          coverage: { returned: 0 },
          error: { code: diagnostic.constraint },
        };
      }

      const limit = Math.min(args.limit ?? defaultLimit, defaultLimit);
      const keyword = args.keyword?.trim();
      diagnostic.queryDispatched = true;
      diagnostic.effectiveLimit = limit;
      let topics: Topic[];
      let searchMayHaveMore: boolean;
      try {
        const result = await lookup({ ...(keyword && { keyword }), limit });
        topics = result.topics.slice(0, limit).map(({ topic, matchCount }) => {
          if (
            typeof topic !== "string" ||
            !/^T[1-9][0-9]{0,2}$/.test(topic) ||
            !Number.isSafeInteger(matchCount) ||
            matchCount < 0
          ) {
            throw new Error("Invalid topic alias");
          }
          return { topic, matchCount };
        });
        searchMayHaveMore =
          result.searchMayHaveMore === true || result.topics.length > limit;
      } catch {
        report({ ...diagnostic, outcome: "lookup-failed" });
        return {
          topics: [],
          coverage: { returned: 0, effectiveLimit: limit },
          error: { code: "lookup-failed" },
        };
      }
      report({
        ...diagnostic,
        outcome: topics.length > 0 ? "found" : "empty",
        count: topics.length,
      });
      return {
        topics,
        coverage: {
          returned: topics.length,
          effectiveLimit: limit,
          searchMayHaveMore,
        },
      };
    },
  };
}

export { createBoundedFind };
