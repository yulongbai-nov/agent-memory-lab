import { createHash } from "node:crypto";
import type { EvidenceRef } from "./training-manifest.cjs";
import type { TrainingSplit, SplitSample } from "./training-split.cjs";

const refFields = [
  "owner",
  "project",
  "harness",
  "instance",
  "session",
  "entry",
  "revision",
] as const;
const hash = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const key = (ref: EvidenceRef): string =>
  JSON.stringify(refFields.map((field) => ref[field]));
function object(
  value: unknown,
  fields: readonly string[],
  where: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((field) => !fields.includes(field)))
    throw new Error(`${where} has an unknown field`);
  return result;
}
function text(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error(`invalid ${where}`);
  return value;
}
function ref(value: unknown): EvidenceRef {
  const o = object(value, refFields, "evidence reference");
  return {
    owner: text(o.owner, "owner"),
    project: text(o.project, "project"),
    harness: text(o.harness, "harness"),
    instance: text(o.instance, "instance"),
    session: text(o.session, "session"),
    entry: text(o.entry, "entry"),
    revision: text(o.revision, "revision"),
  };
}
function verifiedTest(test: TrainingSplit): void {
  const root = object(
    test,
    [
      "version",
      "split",
      "sourceManifestHash",
      "evidenceRegistry",
      "samples",
      "contentHash",
    ],
    "split",
  );
  if (
    root.version !== "training-split-v1" ||
    root.split !== "test" ||
    typeof root.sourceManifestHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(root.sourceManifestHash)
  )
    throw new Error("expected a test split");
  const { contentHash, ...body } = root;
  if (contentHash !== hash(body))
    throw new Error("split content hash mismatch");
  if (
    !Array.isArray(root.samples) ||
    root.samples.length === 0 ||
    root.samples.length > 10000 ||
    !Array.isArray(root.evidenceRegistry)
  )
    throw new Error("invalid split samples or registry");
  const authorized = new Set<string>();
  for (const item of root.evidenceRegistry) {
    const entry = object(
      item,
      ["ref", "purpose", "contentHash", "authorizationId", "sourceSessionId"],
      "registry evidence",
    );
    const k = key(ref(entry.ref));
    if (
      authorized.has(k) ||
      entry.purpose !== "evaluation" ||
      typeof entry.contentHash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(entry.contentHash)
    )
      throw new Error("invalid evaluation evidence registry");
    text(entry.authorizationId, "authorization id");
    if (Object.hasOwn(entry, "sourceSessionId"))
      text(entry.sourceSessionId, "source session id");
    authorized.add(k);
  }
  const ids = new Set<string>();
  const used = new Set<string>();
  for (const item of root.samples) {
    const sample = object(item, ["id", "input", "expected"], "sample");
    const id = text(sample.id, "sample id");
    if (ids.has(id)) throw new Error("duplicate sample id");
    ids.add(id);
    const input = object(sample.input, ["query", "evidence"], "input");
    text(input.query, "query");
    if (
      !Array.isArray(input.evidence) ||
      input.evidence.length === 0 ||
      input.evidence.length > 10000
    )
      throw new Error("invalid sample evidence");
    const refs = new Set<string>();
    for (const item of input.evidence) {
      const evidence = object(item, ["ref", "excerpt"], "sample evidence");
      const k = key(ref(evidence.ref));
      if (refs.has(k)) throw new Error("duplicate sample evidence");
      if (!authorized.has(k))
        throw new Error("sample evidence missing evaluation grant");
      refs.add(k);
      used.add(k);
      text(evidence.excerpt, "excerpt");
    }
    const expected = object(
      sample.expected,
      ["answer", "labels", "validTime", "observedTime"],
      "expected",
    );
    text(expected.answer, "expected answer");
    if (!Array.isArray(expected.labels) || expected.labels.length === 0)
      throw new Error("invalid labels");
  }
  if (used.size !== authorized.size)
    throw new Error("unused evaluation evidence");
}

export interface EvaluationRequests {
  version: "training-eval-requests-v1";
  splitHash: string;
  requests: Array<{ id: string; input: SplitSample["input"] }>;
  contentHash: string;
}
export function buildEvaluationRequests(
  test: TrainingSplit,
): EvaluationRequests {
  verifiedTest(test);
  const body = {
    version: "training-eval-requests-v1" as const,
    splitHash: test.contentHash,
    requests: test.samples.map((sample) => ({
      id: sample.id,
      input: {
        query: sample.input.query,
        evidence: sample.input.evidence.map((e) => ({
          ref: ref(e.ref),
          excerpt: e.excerpt,
        })),
      },
    })),
  };
  return { ...body, contentHash: hash(body) };
}

export function scoreEvaluationResponses(
  test: TrainingSplit,
  predictions: unknown,
) {
  const requests = buildEvaluationRequests(test);
  const root = object(
    predictions,
    ["version", "requestsHash", "responses"],
    "predictions",
  );
  if (
    root.version !== "training-eval-predictions-v1" ||
    root.requestsHash !== requests.contentHash
  )
    throw new Error("prediction version or requests hash mismatch");
  if (
    !Array.isArray(root.responses) ||
    root.responses.length > test.samples.length
  )
    throw new Error("invalid responses");
  const samples = new Map(test.samples.map((sample) => [sample.id, sample]));
  const responses = new Map<
    string,
    { answer: string; evidence: EvidenceRef[] }
  >();
  for (const item of root.responses) {
    const response = object(item, ["id", "answer", "evidence"], "response");
    const id = text(response.id, "response id");
    if (!samples.has(id)) throw new Error("unknown response id");
    if (responses.has(id)) throw new Error("duplicate response id");
    const answer = response.answer;
    if (typeof answer !== "string" || Buffer.byteLength(answer) > 4096)
      throw new Error("invalid response answer");
    if (!Array.isArray(response.evidence) || response.evidence.length > 10000)
      throw new Error("invalid response evidence");
    const evidence = response.evidence.map(ref);
    const unique = new Set(evidence.map(key));
    if (unique.size !== evidence.length)
      throw new Error("duplicate response evidence");
    responses.set(id, { answer, evidence });
  }
  const results = test.samples.map((sample) => {
    const response = responses.get(sample.id);
    const scope = new Set(sample.input.evidence.map((e) => key(e.ref)));
    return {
      id: sample.id,
      responded: response !== undefined,
      answerMatch:
        response !== undefined && response.answer === sample.expected.answer,
      citationScopeMatch:
        response !== undefined &&
        response.evidence.length > 0 &&
        response.evidence.every((e) => scope.has(key(e))),
    };
  });
  return {
    version: "training-eval-report-v1" as const,
    splitHash: test.contentHash,
    requestsHash: requests.contentHash,
    total: results.length,
    responded: responses.size,
    missing: results.length - responses.size,
    answerMatches: results.filter((r) => r.answerMatch).length,
    citationScopeMatches: results.filter((r) => r.citationScopeMatch).length,
    results,
  };
}
