import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

interface IdentityInput {
  harness: string;
  instance: string;
  session: string;
}
interface Identity {
  harness: string;
  instance: string;
  session: string;
}
interface Scope {
  owner: string;
  project: string;
}
interface Source extends Identity {
  snapshotDigest: string;
  representation: string;
  coverage: {
    complete: boolean;
    branchesComplete: boolean;
    attachmentsComplete: boolean;
    truncatedItems: number;
    from: number;
    to: number;
    total: number;
    gaps: { reason: string }[];
  };
}
interface Checkpoint {
  scope: Scope;
  source: Source;
  position: number;
}
interface Options extends Scope {
  file: string;
  instance: string;
  session: string;
  checkpoint?: Checkpoint | null;
  maxRecords?: number;
  batchSize?: number;
}
interface Message {
  id: string;
  role: string;
  text: string;
  created_at: string;
  truncated: boolean;
}
interface Snapshot {
  schema: "agent-memory-chatgpt-snapshot";
  version: 1;
  representation: "connector-projection" | "official-export-normalized";
  conversation: {
    id: string;
    created_at: string;
    branches_complete: boolean;
    attachments_complete: boolean;
  };
  messages: Message[];
}
const {
  sourceIdentity,
}: {
  sourceIdentity: (input: IdentityInput) => Identity;
} = require("../adapters/index.js");
const {
  checkpointRevision,
}: {
  checkpointRevision: (checkpoint: Checkpoint | null) => string | null;
} = require("../checkpoint.cjs");
const hash = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function unknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function timestamp(value: unknown): value is string {
  return (
    nonempty(value) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function parseSnapshot(value: unknown): Snapshot {
  if (
    !object(value) ||
    !exact(value, [
      "schema",
      "version",
      "representation",
      "conversation",
      "messages",
    ]) ||
    value.schema !== "agent-memory-chatgpt-snapshot" ||
    value.version !== 1 ||
    (value.representation !== "connector-projection" &&
      value.representation !== "official-export-normalized") ||
    !object(value.conversation) ||
    !exact(value.conversation, [
      "id",
      "created_at",
      "branches_complete",
      "attachments_complete",
    ]) ||
    !nonempty(value.conversation.id) ||
    !timestamp(value.conversation.created_at) ||
    typeof value.conversation.branches_complete !== "boolean" ||
    typeof value.conversation.attachments_complete !== "boolean" ||
    !unknownArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > 100000
  )
    throw new Error("Invalid or unsupported ChatGPT snapshot");
  const messages: Message[] = [];
  const seen = new Set<string>();
  for (const candidate of value.messages) {
    if (
      !object(candidate) ||
      !exact(candidate, ["id", "role", "text", "created_at", "truncated"]) ||
      !nonempty(candidate.id) ||
      !["user", "assistant", "system", "tool"].some(
        (role) => role === candidate.role,
      ) ||
      typeof candidate.role !== "string" ||
      typeof candidate.text !== "string" ||
      Buffer.byteLength(candidate.text) > 1024 * 1024 ||
      !timestamp(candidate.created_at) ||
      typeof candidate.truncated !== "boolean" ||
      seen.has(candidate.id)
    )
      throw new Error("Invalid ChatGPT snapshot message");
    seen.add(candidate.id);
    messages.push({
      id: candidate.id,
      role: candidate.role,
      text: candidate.text,
      created_at: candidate.created_at,
      truncated: candidate.truncated,
    });
  }
  return {
    schema: value.schema,
    version: value.version,
    representation: value.representation,
    conversation: {
      id: value.conversation.id,
      created_at: value.conversation.created_at,
      branches_complete: value.conversation.branches_complete,
      attachments_complete: value.conversation.attachments_complete,
    },
    messages,
  };
}
async function* readChatgptSnapshot(opts: Options) {
  if (
    !opts ||
    !nonempty(opts.file) ||
    !nonempty(opts.owner) ||
    !nonempty(opts.project) ||
    !nonempty(opts.instance) ||
    !nonempty(opts.session)
  )
    throw new TypeError(
      "file, owner, project, instance and session are required",
    );
  const info = await stat(opts.file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024)
    throw new Error("ChatGPT snapshot exceeds file limit or is not a file");
  const bytes = await readFile(opts.file);
  if (bytes.length > 16 * 1024 * 1024)
    throw new Error("ChatGPT snapshot exceeds file limit");
  const snapshot = parseSnapshot(JSON.parse(bytes.toString("utf8")) as unknown);
  if (snapshot.conversation.id !== opts.session)
    throw new Error("ChatGPT snapshot session mismatch");
  const digest = `sha256:${hash(bytes)}`;
  const scope = { owner: opts.owner, project: opts.project };
  const identity = sourceIdentity({
    harness: "chatgpt",
    instance: opts.instance,
    session: opts.session,
  });
  const prior = opts.checkpoint ?? null;
  if (
    prior &&
    (prior.source.snapshotDigest !== digest ||
      prior.scope.owner !== scope.owner ||
      prior.scope.project !== scope.project ||
      prior.source.harness !== identity.harness ||
      prior.source.instance !== identity.instance ||
      prior.source.session !== identity.session ||
      !Number.isSafeInteger(prior.position) ||
      prior.position < 0 ||
      prior.position > snapshot.messages.length)
  )
    throw new Error("ChatGPT snapshot checkpoint mismatch");
  const maxRecords =
    Number.isSafeInteger(opts.maxRecords) && (opts.maxRecords ?? 0) > 0
      ? Math.min(opts.maxRecords ?? 0, 100000)
      : 3000;
  const batchSize =
    Number.isSafeInteger(opts.batchSize) && (opts.batchSize ?? 0) > 0
      ? Math.min(opts.batchSize ?? 0, 500)
      : 100;
  let position = prior?.position ?? 0;
  const limit = Math.min(snapshot.messages.length, position + maxRecords);
  let revision = checkpointRevision(prior);
  while (position < limit) {
    const previous = position;
    position = Math.min(limit, position + batchSize);
    const truncatedItems = snapshot.messages.filter(
      (message) => message.truncated,
    ).length;
    const gaps = [
      ...(snapshot.representation === "connector-projection"
        ? ["connector-projection"]
        : []),
      ...(!snapshot.conversation.branches_complete
        ? ["branches-incomplete"]
        : []),
      ...(!snapshot.conversation.attachments_complete
        ? ["attachments-incomplete"]
        : []),
      ...(truncatedItems ? ["truncated-items"] : []),
      ...(position < snapshot.messages.length ? ["scan-limit"] : []),
    ].map((reason) => ({ reason }));
    const source: Source = {
      ...identity,
      snapshotDigest: digest,
      representation: snapshot.representation,
      coverage: {
        complete: gaps.length === 0,
        branchesComplete: snapshot.conversation.branches_complete,
        attachmentsComplete: snapshot.conversation.attachments_complete,
        truncatedItems,
        from: 1,
        to: position,
        total: snapshot.messages.length,
        gaps,
      },
    };
    const items = snapshot.messages
      .slice(previous, position)
      .map((message) => ({
        id: `chatgpt-message-v1:${hash(JSON.stringify([identity.session, message.id]))}`,
        kind: "message",
        role: message.role,
        text: message.text,
        time: message.created_at,
        metadata: {
          adapterVersion: "chatgpt-snapshot-v1",
          representation: snapshot.representation,
          truncated: message.truncated,
          originalBytes: false,
          locator: "unavailable",
          conversationCreatedAt: snapshot.conversation.created_at,
        },
      }));
    const checkpoint = {
      previous: prior === null && previous === 0 ? null : previous,
      previousRevision: revision,
      position,
    };
    yield { scope, source, checkpoint, items };
    revision = checkpointRevision({ scope, source, position });
  }
}
module.exports = { readChatgptSnapshot };
