import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";

type Command = "draft-list" | "draft-show";
type Scope = { owner: string; project: string };
type Source = { harness: string; instance: string; session: string };
type Span = {
  kind: "full" | "fragment" | "relay-input";
  fieldPath: string;
  originalSha256: string;
  startUtf16: number;
  endUtf16: number;
  startUtf8: number;
  endUtf8: number;
  previewStartUtf16: number;
  previewEndUtf16: number;
};
type Reference = { source: string; item: string; version: string };
type Evidence = Reference & { quote: string; originalSpan?: Span };
type Candidate = {
  kind: "decision" | "change" | "correction" | "todo";
  status: "待核实";
  claim: string;
  evidence: Evidence[];
};
type Draft = {
  runtime: "macos-offline-private";
  scopeKey: string;
  generatedAt: string;
  draftFile: string;
  inputProjections?: (Reference & Span)[];
  candidates: Candidate[];
};
type Row = {
  item: { text?: string | null; metadata?: { original?: unknown } };
};
type Choice = { text: string; start: number; end: number };
type OriginalStatus =
  | "verified"
  | "source-only"
  | "missing-locally"
  | "integrity-failed"
  | "too-large"
  | "unknown";
type Archive = {
  dir: string;
  close?: () => void;
  lookupDraftEvidence: (
    input: Scope & { source: Source; id: string; revision: string },
  ) => Promise<{ row: Row; currentRevision: string } | null>;
};
type Dependencies = {
  openStorage: (input: {
    dir: string;
    readOnly: true;
  }) => Promise<{ dir: string }>;
  openArchive: (input: { dir: string; readOnly: true }) => Promise<Archive>;
  projectionChoices: (text: string) => Choice[];
  inspectDraftEvidence: (
    dir: string,
    row: Row,
    choices: Choice[],
  ) => Promise<{
    status: OriginalStatus;
    projections: { text: string; projection: Span }[];
  }>;
};

const MAX_DRAFT_BYTES = 96 * 1024;
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = { type: "string", pattern: "^[a-f0-9]{64}$" };
const label = { type: "string", minLength: 1, maxLength: 512, pattern: "\\S" };
const prose = { ...label, maxLength: 4096 };
const offset = { type: "integer", minimum: 0, maximum: 1024 * 1024 };
const ref = {
  source: { ...label, pattern: "^(?:codex|dsh)/[^/]+/[^/]+$" },
  item: label,
  version: hex,
};
const span = {
  kind: { enum: ["full", "fragment", "relay-input"] },
  fieldPath: label,
  originalSha256: hex,
  startUtf16: offset,
  endUtf16: offset,
  startUtf8: offset,
  endUtf8: offset,
  previewStartUtf16: offset,
  previewEndUtf16: offset,
};
const object = (properties: object, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const checkDraft = new Ajv({ ownProperties: true }).compile<Draft>(
  object(
    {
      runtime: { const: "macos-offline-private" },
      scopeKey: hex,
      generatedAt: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
      },
      draftFile: { type: "string", pattern: "^draft-[a-f0-9]{64}\\.txt$" },
      inputProjections: {
        type: "array",
        maxItems: 5,
        items: object({ ...ref, ...span }),
      },
      candidates: {
        type: "array",
        maxItems: 4,
        items: object({
          kind: { enum: ["decision", "change", "correction", "todo"] },
          status: { const: "待核实" },
          claim: prose,
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: object(
              { ...ref, quote: prose, originalSpan: object(span) },
              [...Object.keys(ref), "quote"],
            ),
          },
        }),
      },
    },
    ["runtime", "scopeKey", "generatedAt", "draftFile", "candidates"],
  ),
);

const candidateId = /^([a-f0-9]{64}):([1-4])$/u;
function fail(status: string) {
  return { result: { status }, exitCode: 1 };
}
function ok<T extends object>(result: T) {
  return { result, exitCode: 0 };
}
function errno(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code;
}
function explicit(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function readSnapshot(dir: string, scopeKey: string) {
  const folder = join(dir, "local-derive");
  try {
    const stat = await lstat(folder);
    if (
      !stat.isDirectory() ||
      stat.mode & 0o077 ||
      (await realpath(folder)) !== folder
    )
      throw Error("Invalid draft folder");
    const file = await open(
      join(folder, `latest-${scopeKey}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const initial = await file.stat();
      if (
        !initial.isFile() ||
        initial.mode & 0o077 ||
        initial.size < 1 ||
        initial.size > MAX_DRAFT_BYTES
      )
        throw Error("Invalid draft file");
      const buffer = Buffer.alloc(initial.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat();
      if (
        length !== initial.size ||
        after.size !== initial.size ||
        after.mtimeMs !== initial.mtimeMs ||
        after.mode & 0o077
      )
        throw Error("Draft changed while reading");
      const bytes = buffer.subarray(0, length);
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (
        !checkDraft(value) ||
        value.scopeKey !== scopeKey ||
        !Number.isFinite(Date.parse(value.generatedAt))
      )
        throw Error("Invalid draft snapshot");
      return { snapshot: sha(bytes), draft: value };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

function splitsSurrogate(text: string, at: number) {
  const left = text.charCodeAt(at - 1),
    right = text.charCodeAt(at);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}
function containsExactQuote(text: string, quote: string) {
  for (
    let at = text.indexOf(quote);
    at >= 0;
    at = text.indexOf(quote, at + 1)
  ) {
    if (!splitsSurrogate(text, at) && !splitsSurrogate(text, at + quote.length))
      return true;
  }
  return false;
}
function matchesSpan(
  quote: string,
  span: Span,
  text: string,
  projection: Span,
) {
  const start = span.previewStartUtf16 - projection.previewStartUtf16;
  const end = start + quote.length;
  if (
    start < 0 ||
    end > text.length ||
    splitsSurrogate(text, start) ||
    splitsSurrogate(text, end) ||
    text.slice(start, end) !== quote ||
    span.previewEndUtf16 !== span.previewStartUtf16 + quote.length
  )
    return false;
  const byteStart =
    projection.startUtf8 + Buffer.byteLength(text.slice(0, start));
  return (
    span.kind === projection.kind &&
    span.fieldPath === projection.fieldPath &&
    span.originalSha256 === projection.originalSha256 &&
    span.startUtf16 === projection.startUtf16 + start &&
    span.endUtf16 === projection.startUtf16 + end &&
    span.startUtf8 === byteStart &&
    span.endUtf8 === byteStart + Buffer.byteLength(quote)
  );
}

const spanKeys = Object.keys(span) as (keyof Span)[];
function sameProjection(left: Span, right: Span) {
  return spanKeys.every((key) => left[key] === right[key]);
}

async function evidenceDetail(
  archive: Archive,
  scope: Scope,
  evidence: Evidence,
  inputs: Draft["inputProjections"],
  { projectionChoices, inspectDraftEvidence }: Dependencies,
) {
  const [harness, instance, session] = evidence.source.split("/");
  if (!harness || !instance || !session) throw Error("Invalid source identity");
  const result = await archive.lookupDraftEvidence({
    ...scope,
    source: { harness, instance, session },
    id: evidence.item,
    revision: evidence.version,
  });
  if (!result)
    return {
      sourceStatus: "missing" as const,
      originalStatus: "unknown" as const,
      quoteStatus: "unverified" as const,
    };
  const { row, currentRevision } = result;
  const sourceStatus =
    currentRevision === evidence.version ? "current" : "older-version";
  const saved =
    inputs?.filter(
      ({ source, item, version }) =>
        source === evidence.source &&
        item === evidence.item &&
        version === evidence.version,
    ) ?? [];
  const choices = projectionChoices(row.item.text ?? "").filter(
    ({ start, end }) =>
      !inputs?.length ||
      saved.some(
        (input) =>
          input.previewStartUtf16 === start && input.previewEndUtf16 === end,
      ),
  );
  const { status: originalStatus, projections } = await inspectDraftEvidence(
    archive.dir,
    row,
    choices,
  );
  const base = {
    source: evidence.source,
    item: evidence.item,
    version: evidence.version,
    sourceStatus,
    originalStatus,
  };
  const { quote, originalSpan } = evidence;
  if (
    originalStatus === "verified" &&
    originalSpan &&
    projections.some(
      ({ text, projection }) =>
        saved.some((input) => sameProjection(input, projection)) &&
        matchesSpan(quote, originalSpan, text, projection),
    )
  )
    return {
      ...base,
      quoteStatus: "verified-original" as const,
      quote,
      originalSpan,
    };
  if (
    originalStatus !== "integrity-failed" &&
    (!originalSpan || originalStatus !== "verified") &&
    choices.some(({ text, start }) => {
      if (!originalSpan) return containsExactQuote(text, quote);
      const offset = originalSpan.previewStartUtf16 - start;
      return (
        offset >= 0 &&
        originalSpan.previewEndUtf16 ===
          originalSpan.previewStartUtf16 + quote.length &&
        !splitsSurrogate(text, offset) &&
        !splitsSurrogate(text, offset + quote.length) &&
        text.slice(offset, offset + quote.length) === quote
      );
    })
  )
    return { ...base, quoteStatus: "archived-preview-only" as const, quote };
  return { ...base, quoteStatus: "unverified" as const };
}

async function readLocalDraft(
  command: Command,
  options: Record<string, unknown>,
  dependencies: Dependencies,
) {
  const { dir, owner, project, id } = options;
  const isDetail = command === "draft-show";
  const allowed = isDetail
    ? ["dir", "owner", "project", "id"]
    : ["dir", "owner", "project"];
  if (
    !explicit(dir) ||
    !explicit(owner) ||
    !explicit(project) ||
    Object.keys(options).some((key) => !allowed.includes(key))
  )
    return fail("invalid-input");
  const requested =
    isDetail && typeof id === "string" ? candidateId.exec(id) : null;
  if (isDetail && (!requested || requested[0] !== id))
    return fail("invalid-input");
  const scope = { owner, project };
  let archiveDir: string;
  try {
    archiveDir = await realpath(
      (await dependencies.openStorage({ dir, readOnly: true })).dir,
    );
  } catch {
    return fail("archive-unavailable");
  }
  let latest: Awaited<ReturnType<typeof readSnapshot>>;
  try {
    latest = await readSnapshot(
      archiveDir,
      sha(JSON.stringify([owner, project])),
    );
  } catch {
    return fail("invalid-draft");
  }
  if (!latest)
    return requested
      ? fail("snapshot-changed")
      : ok({ status: "no-draft", scope, candidates: [] });
  const { snapshot, draft } = latest;
  const batch = { scope, snapshot, generatedAt: draft.generatedAt };
  if (!requested)
    return ok({
      status: draft.candidates.length ? "ready" : "empty",
      ...batch,
      candidates: draft.candidates.map(({ kind, status, evidence }, index) => ({
        id: `${snapshot}:${index + 1}`,
        kind,
        status,
        referenceCount: evidence.length,
      })),
    });
  if (requested[1] !== snapshot) return fail("snapshot-changed");
  const candidate = draft.candidates[Number(requested[2]) - 1];
  if (!candidate) return fail("candidate-not-found");
  let archive: Archive | undefined;
  try {
    archive = await dependencies.openArchive({
      dir: archiveDir,
      readOnly: true,
    });
    const evidence = [];
    for (const reference of candidate.evidence)
      evidence.push(
        await evidenceDetail(
          archive,
          scope,
          reference,
          draft.inputProjections,
          dependencies,
        ),
      );
    return ok({
      status: "ready",
      ...batch,
      candidate: {
        id,
        kind: candidate.kind,
        status: candidate.status,
        ...(evidence.every((entry) => entry.quoteStatus !== "unverified")
          ? { claim: candidate.claim }
          : {}),
        evidence,
      },
    });
  } catch {
    return fail("archive-unavailable");
  } finally {
    archive?.close?.();
  }
}

export { readLocalDraft };
