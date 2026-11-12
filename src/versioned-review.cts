import { createRequire } from "node:module";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  link,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateReceipt,
  validateSnapshot,
  validateCapsule,
  hash,
  canonical,
} from "./candidate-review-contract.cjs";
import type {
  Snapshot,
  Candidate,
  Projection,
  Capsule,
} from "./candidate-review-contract.cjs";

const { openArchive } = createRequire(__filename)("../archive.cjs") as {
  openArchive: (v: unknown) => Promise<Archive>;
};
const { withWriterLock } = createRequire(__filename)("../lock.cjs") as {
  withWriterLock: <T>(
    dir: string,
    name: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
};
const { verifyDeclaredProjection, previewDeclaredProjection } = createRequire(
  __filename,
)("../local-derive-projection.cjs") as {
  verifyDeclaredProjection: (
    dir: string,
    row: unknown,
    p: Projection,
  ) => Promise<{ status: string; text?: string }>;
  previewDeclaredProjection: (row: unknown, p: Projection) => string | null;
};
type Scope = { owner: string; project: string };
type Archive = {
  dir: string;
  close?: () => void;
  getItem: (x: unknown) => Promise<{
    item: { text?: string };
    source: { harness: string; instance: string; session: string };
  } | null>;
  addAnnotation: (x: unknown) => Promise<unknown>;
};
const max = 96 * 1024,
  hex = /^[a-f0-9]{64}$/u;
function scopeKey(scope: Scope) {
  if (!scope.owner?.trim() || !scope.project?.trim())
    throw Error("Explicit scope required");
  return hash(JSON.stringify([scope.owner, scope.project]));
}
function sameRef(
  a: { source: string; item: string; version: string },
  b: { source: string; item: string; version: string },
) {
  return a.source === b.source && a.item === b.item && a.version === b.version;
}
async function readPrivate(file: string, limit = max) {
  const before = await lstat(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.mode & 0o077 ||
    before.size < 1 ||
    before.size > limit ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    throw Error("Invalid private file");
  const h = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const st = await h.stat();
    if (
      st.dev !== before.dev ||
      st.ino !== before.ino ||
      st.size !== before.size
    )
      throw Error("File changed");
    const buffer = Buffer.alloc(st.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await h.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await h.stat();
    if (
      length !== st.size ||
      after.size !== st.size ||
      after.mtimeMs !== st.mtimeMs
    )
      throw Error("File changed");
    return buffer.subarray(0, length);
  } finally {
    await h.close();
  }
}
async function dirPrivate(parent: string, name: string, create: boolean) {
  const dir = join(parent, name);
  if (create)
    await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  const st = await lstat(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (typeof process.getuid === "function" && st.uid !== process.getuid()) ||
    st.mode & 0o077 ||
    (await realpath(dir)) !== dir
  )
    throw Error("Invalid private directory");
  return dir;
}
async function paths(archive: Archive, scope: Scope, create: boolean) {
  const a = await dirPrivate(
      await realpath(archive.dir),
      "local-derive",
      create,
    ),
    b = await dirPrivate(a, "draft-v2", create),
    c = await dirPrivate(b, scopeKey(scope), create),
    d = create ? await dirPrivate(c, "snapshots", true) : join(c, "snapshots");
  return { dir: c, snapshots: d, latest: join(c, "latest.json") };
}
async function syncDirectory(file: string) {
  const h = await open(dirname(file), "r");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function atomic(file: string, bytes: Buffer) {
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    const h = await open(tmp, "wx", 0o600);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(tmp, file);
    await syncDirectory(file);
  } finally {
    await rm(tmp, { force: true });
  }
}
async function latest(file: string): Promise<string | null> {
  try {
    const v: unknown = JSON.parse(
      (await readPrivate(file, 1024)).toString("utf8"),
    );
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).join() !== "snapshotSha256" ||
      !hex.test((v as { snapshotSha256: string }).snapshotSha256)
    )
      throw Error("Invalid latest");
    return (v as { snapshotSha256: string }).snapshotSha256;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function snapshotAt(folder: string, id: string, scope: Scope) {
  if (!hex.test(id)) throw Error("Invalid snapshot ID");
  await dirPrivate(dirname(folder), "snapshots", false);
  const bytes = await readPrivate(join(folder, id + ".json"));
  if (hash(bytes.toString("utf8")) !== id)
    throw Error("Snapshot hash mismatch");
  const snapshot = validateSnapshot(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (snapshot.scopeKey !== scopeKey(scope))
    throw Error("Snapshot scope mismatch");
  return snapshot;
}
function splitSource(s: string) {
  const [harness, instance, session, ...rest] = s.split("/");
  if (!harness || !instance || !session || rest.length)
    throw Error("Invalid source");
  return { harness, instance, session };
}
function matchesQuote(
  e: Candidate["evidence"][number],
  p: Projection,
  text: string,
) {
  const q = e.originalSpan,
    at = q.previewStartUtf16 - p.previewStartUtf16,
    end = at + e.quote.length;
  if (
    at < 0 ||
    end > text.length ||
    text.slice(at, end) !== e.quote ||
    (at > 0 &&
      /[\uD800-\uDBFF]/u.test(text[at - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(text[at]!)) ||
    (end < text.length &&
      /[\uD800-\uDBFF]/u.test(text[end - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(text[end]!)) ||
    q.previewEndUtf16 !== q.previewStartUtf16 + e.quote.length
  )
    return false;
  const byteStart = p.startUtf8 + Buffer.byteLength(text.slice(0, at));
  return (
    q.kind === p.kind &&
    q.fieldPath === p.fieldPath &&
    q.originalSha256 === p.originalSha256 &&
    q.startUtf16 === p.startUtf16 + at &&
    q.endUtf16 === p.startUtf16 + end &&
    q.startUtf8 === byteStart &&
    q.endUtf8 === byteStart + Buffer.byteLength(e.quote)
  );
}
async function evidenceDetails(
  archive: Archive,
  scope: Scope,
  candidate: Candidate,
  inputs: Projection[],
) {
  const details = [];
  for (const evidence of candidate.evidence) {
    const row = await archive.getItem({
      ...scope,
      source: splitSource(evidence.source),
      id: evidence.item,
      revision: evidence.version,
    });
    if (!row) {
      details.push({
        source: evidence.source,
        item: evidence.item,
        version: evidence.version,
        quoteStatus: "unverified",
        originalStatus: "unknown",
      });
      continue;
    }
    let status = "unverified",
      originalStatus = "unknown";
    for (const p of inputs.filter((x) => sameRef(x, evidence))) {
      const text = previewDeclaredProjection(row, p);
      if (!text || !matchesQuote(evidence, p, text)) continue;
      const projected = await verifyDeclaredProjection(archive.dir, row, p);
      originalStatus = projected.status;
      if (projected.status === "verified" && projected.text === text) {
        status = "verified-original";
        break;
      }
      if (["missing-locally", "source-only"].includes(projected.status))
        status = "archived-preview-only";
    }
    details.push({
      source: evidence.source,
      item: evidence.item,
      version: evidence.version,
      quoteStatus: status,
      originalStatus,
      ...(status !== "unverified" ? { quote: evidence.quote } : {}),
      ...(status === "verified-original"
        ? { originalSpan: evidence.originalSpan }
        : {}),
    });
  }
  return details;
}
async function verify(
  archive: Archive,
  scope: Scope,
  candidates: Candidate[],
  inputs: Projection[],
) {
  for (const candidate of candidates) {
    const details = await evidenceDetails(archive, scope, candidate, inputs);
    if (details.some((e) => e.quoteStatus !== "verified-original"))
      throw Error("Evidence verification failed");
  }
}

async function verifiedInputs(
  archive: Archive,
  scope: Scope,
  candidate: Candidate,
  inputs: Projection[],
) {
  const picked: Projection[] = [];
  for (const evidence of candidate.evidence) {
    const row = await archive.getItem({
      ...scope,
      source: splitSource(evidence.source),
      id: evidence.item,
      revision: evidence.version,
    });
    if (!row) throw Error("Evidence unavailable");
    let selected: Projection | undefined;
    for (const p of inputs.filter((x) => sameRef(x, evidence))) {
      const result = await verifyDeclaredProjection(archive.dir, row, p);
      if (
        result.status === "verified" &&
        result.text &&
        matchesQuote(evidence, p, result.text)
      ) {
        selected = p;
        break;
      }
    }
    if (!selected) throw Error("Evidence verification failed");
    if (!picked.some((x) => canonical(x) === canonical(selected)))
      picked.push(selected);
  }
  return picked;
}
function scoped(scope: Scope) {
  return { owner: scope.owner, project: scope.project };
}
async function publish(options: {
  dir: string;
  owner: string;
  project: string;
  receipt: string;
  receiptSha256: string;
  expectLatest: string;
}) {
  const scope = scoped(options),
    key = scopeKey(scope);
  if (
    !hex.test(options.receiptSha256) ||
    !(options.expectLatest === "none" || hex.test(options.expectLatest))
  )
    throw Error("Invalid publish arguments");
  const bytes = await readPrivate(options.receipt);
  if (hash(bytes.toString("utf8")) !== options.receiptSha256)
    throw Error("Receipt hash mismatch");
  const data = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Record<string, unknown>;
  if (Array.isArray(data.candidates))
    data.candidates = data.candidates.map((v: unknown) => {
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.hasOwn(v, "status")
      )
        throw Error("Receipt cannot assign review status");
      return v && typeof v === "object" && !Array.isArray(v)
        ? { ...v, status: "待核实" }
        : v;
    });
  const receipt = validateReceipt(data);
  if (
    receipt.scope.owner !== scope.owner ||
    receipt.scope.project !== scope.project
  )
    throw Error("Receipt scope mismatch");
  const archive = await openArchive({ dir: options.dir, readOnly: true });
  try {
    return await withWriterLock(archive.dir, "draft-v2:" + key, async () => {
      await verify(
        archive,
        scope,
        receipt.candidates,
        receipt.inputProjections,
      );
      const p = await paths(archive, scope, true);
      const snapshot: Snapshot = {
        formatVersion: 2,
        scopeKey: key,
        producer: receipt.producer,
        generatedAt: receipt.generatedAt,
        ...(receipt.originReceiptSha256
          ? { originReceiptSha256: receipt.originReceiptSha256 }
          : {}),
        admission: {
          kind: "operator-import",
          receiptSha256: options.receiptSha256,
        },
        inputProjections: receipt.inputProjections,
        candidates: receipt.candidates,
      };
      validateSnapshot(snapshot);
      const content = Buffer.from(JSON.stringify(snapshot));
      if (content.length > max) throw Error("Snapshot too large");
      const id = hash(content.toString("utf8")),
        current = await latest(p.latest);
      if (current === id) {
        await snapshotAt(p.snapshots, id, scope);
        return { status: "published", snapshot: id, replayed: true };
      }
      if ((current ?? "none") !== options.expectLatest)
        throw Error("Latest snapshot changed");
      const file = join(p.snapshots, id + ".json"),
        tmp = join(p.snapshots, "." + randomUUID() + ".tmp");
      try {
        const h = await open(tmp, "wx", 0o600);
        try {
          await h.writeFile(content);
          await h.sync();
        } finally {
          await h.close();
        }
        try {
          await link(tmp, file);
          await syncDirectory(file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          await snapshotAt(p.snapshots, id, scope);
        }
      } finally {
        await rm(tmp, { force: true });
      }
      await atomic(
        p.latest,
        Buffer.from(JSON.stringify({ snapshotSha256: id })),
      );
      return { status: "published", snapshot: id, replayed: false };
    });
  } finally {
    archive.close?.();
  }
}
async function readV2(options: {
  dir: string;
  owner: string;
  project: string;
  id?: string;
}) {
  const scope = scoped(options),
    archive = await openArchive({ dir: options.dir, readOnly: true });
  let hasPointer = false;
  try {
    const p = await paths(archive, scope, false),
      id = options.id?.split(":")[0] ?? (await latest(p.latest));
    if (!id) return { status: "no-draft", candidates: [] };
    hasPointer = true;
    const snapshot = await snapshotAt(p.snapshots, id, scope);
    if (options.id) {
      const match = /^([a-f0-9]{64}):([1-4])$/u.exec(options.id);
      if (!match || match[1] !== id) throw Error("Invalid candidate ID");
      const candidate = snapshot.candidates[Number(match[2]) - 1];
      if (!candidate) throw Error("Candidate not found");
      const evidence = await evidenceDetails(
        archive,
        scope,
        candidate,
        snapshot.inputProjections,
      );
      return {
        status: "ready",
        snapshot: id,
        producer: snapshot.producer,
        producerStatus: "reported",
        generatedAt: snapshot.generatedAt,
        ...(snapshot.originReceiptSha256
          ? { originReceiptSha256: snapshot.originReceiptSha256 }
          : {}),
        admission: snapshot.admission,
        candidate: {
          id: options.id,
          kind: candidate.kind,
          ...(candidate.basis ? { basis: candidate.basis } : {}),
          status: candidate.status,
          ...(evidence.every((e) => e.quoteStatus !== "unverified")
            ? { claim: candidate.claim }
            : {}),
          evidence,
        },
      };
    }
    return {
      status: snapshot.candidates.length ? "ready" : "empty",
      snapshot: id,
      producer: snapshot.producer,
      producerStatus: "reported",
      generatedAt: snapshot.generatedAt,
      ...(snapshot.originReceiptSha256
        ? { originReceiptSha256: snapshot.originReceiptSha256 }
        : {}),
      admission: snapshot.admission,
      candidates: snapshot.candidates.map((c, i) => ({
        id: id + ":" + (i + 1),
        kind: c.kind,
        ...(c.basis ? { basis: c.basis } : {}),
        status: c.status,
        referenceCount: c.evidence.length,
      })),
    };
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" &&
      !options.id &&
      !hasPointer
    )
      return { status: "no-draft", candidates: [] };
    throw e;
  } finally {
    archive.close?.();
  }
}
async function review(options: {
  dir: string;
  owner: string;
  project: string;
  id: string;
  basis?: string;
  text: string;
  topic: string;
  primary?: number;
}) {
  const scope = scoped(options),
    match = /^([a-f0-9]{64}):([1-4])$/u.exec(options.id);
  if (!match || !options.text?.trim() || !options.topic?.trim())
    throw Error("Invalid review arguments");
  const archive = await openArchive({ dir: options.dir, readOnly: false });
  try {
    const p = await paths(archive, scope, false),
      snapshot = await snapshotAt(p.snapshots, match[1]!, scope),
      ordinal = Number(match[2]),
      candidate = snapshot.candidates[ordinal - 1],
      primary = options.primary ?? 1;
    if (
      !candidate ||
      !Number.isInteger(primary) ||
      primary < 1 ||
      primary > candidate.evidence.length ||
      (candidate.evidence.length > 1 && options.primary === undefined) ||
      !["decision", "todo"].includes(candidate.kind) ||
      (candidate.kind === "decision"
        ? !["confirmed", "proposed", "uncertain"].includes(options.basis || "")
        : options.basis !== undefined)
    )
      throw Error("Unsupported review");
    const inputs = await verifiedInputs(
      archive,
      scope,
      candidate,
      snapshot.inputProjections,
    );
    const evidence = candidate.evidence[primary - 1];
    if (!evidence) throw Error("Missing primary evidence");
    const target = {
      id: evidence.item,
      revision: evidence.version,
      source: splitSource(evidence.source),
    };
    const capsule: Omit<Capsule, "reviewedAt"> = {
      formatVersion: 2,
      snapshotSha256: match[1]!,
      ordinal,
      candidateSha256: hash(canonical(candidate)),
      producer: snapshot.producer,
      generatedAt: snapshot.generatedAt,
      ...(snapshot.originReceiptSha256
        ? { originReceiptSha256: snapshot.originReceiptSha256 }
        : {}),
      admission: snapshot.admission,
      candidate,
      inputProjections: inputs,
      primary,
    };
    const id =
      "candidate-review-" +
      hash(JSON.stringify([scope.owner, scope.project, options.id]));
    const accepted = (await archive.addAnnotation({
      id,
      scope,
      kind: candidate.kind,
      text: options.text,
      topic: options.topic,
      ...(options.basis ? { basis: options.basis } : {}),
      target,
      candidateReview: capsule,
    })) as { candidateReview: { reviewedAt: string } };
    return {
      status: "reviewed",
      id,
      kind: candidate.kind,
      ...(options.basis ? { basis: options.basis } : {}),
      reviewedAt: accepted.candidateReview.reviewedAt,
      candidateId: options.id,
      candidateSha256: capsule.candidateSha256,
    };
  } finally {
    archive.close?.();
  }
}
async function showReview(options: {
  dir: string;
  owner: string;
  project: string;
  reviewId: string;
}) {
  const scope = scoped(options),
    archive = await openArchive({ dir: options.dir, readOnly: true });
  try {
    const entry = await (
      archive as Archive & {
        getAnnotation: (x: Scope & { id: string }) => Promise<{
          id: string;
          kind: string;
          text: string;
          topic?: string;
          basis?: string;
          target: unknown;
          candidateReview?: unknown;
        } | null>;
      }
    ).getAnnotation({ ...scope, id: options.reviewId });
    if (!entry?.candidateReview) throw Error("Review not found");
    const capsule = validateCapsule(entry.candidateReview);
    let snapshotStatus: "verified" | "missing" | "invalid" = "missing";
    try {
      const p = await paths(archive, scope, false),
        snapshot = await snapshotAt(p.snapshots, capsule.snapshotSha256, scope),
        candidate = snapshot.candidates[capsule.ordinal - 1];
      snapshotStatus =
        candidate && hash(canonical(candidate)) === capsule.candidateSha256
          ? "verified"
          : "invalid";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        snapshotStatus = "invalid";
    }
    const evidence = await evidenceDetails(
        archive,
        scope,
        capsule.candidate,
        capsule.inputProjections,
      ),
      candidate = capsule.candidate;
    return {
      status: "ready",
      snapshotStatus,
      review: {
        reviewedAt: capsule.reviewedAt,
        id: entry.id,
        kind: entry.kind,
        text: entry.text,
        ...(entry.topic ? { topic: entry.topic } : {}),
        ...(entry.basis ? { basis: entry.basis } : {}),
        target: entry.target,
      },
      candidate: {
        id: capsule.snapshotSha256 + ":" + capsule.ordinal,
        kind: candidate.kind,
        ...(candidate.basis ? { basis: candidate.basis } : {}),
        status: candidate.status,
        ...(evidence.every((e) => e.quoteStatus !== "unverified")
          ? { claim: candidate.claim }
          : {}),
        evidence,
      },
      producer: capsule.producer,
      producerStatus: "reported",
      generatedAt: capsule.generatedAt,
      admission: capsule.admission,
    };
  } finally {
    archive.close?.();
  }
}

export { publish, readV2, review, showReview };
