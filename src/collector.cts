import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { discoverIntakeSources } = load("../codex-discovery.cjs") as {
  discoverIntakeSources: {
    (op: Operation, input: SingleInput, root: string): Promise<Snapshot>;
    (
      op: CombinedOperation,
      input: CombinedInput,
      root: string,
    ): Promise<Snapshot>;
  };
};
const { withWriterLock } = load("../lock.cjs") as {
  withWriterLock: <T>(
    dir: string,
    name: string,
    fn: () => T | Promise<T>,
    options?: { legacyLock: string; timeoutMs: number },
  ) => Promise<T>;
};
const hash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
const signature = (st: import("node:fs").Stats) =>
  hash(JSON.stringify([st.size, st.mtimeMs, st.ctimeMs, st.ino]));
const MAX_TRACKED_IDENTITIES = 20_000;
interface Operation {
  scope: { owner: string; project: string };
  archive: {
    dir: string;
    indexFile?: string;
    getCheckpoint?: (key: CheckpointKey) => Promise<unknown>;
  };
}
interface CheckpointKey {
  owner: string;
  project: string;
  harness: string;
  instance: string;
  session: string;
}
type CombinedOperation = Operation & {
  archive: { getCheckpoint: (key: CheckpointKey) => Promise<unknown> };
};
interface Input {
  root: string;
  instance: string;
  source: string;
  archiveRoot?: string | undefined;
  "max-sessions"?: string | number;
  "max-archive-mib"?: string | number;
  [key: string]: unknown;
}
interface FileEntry {
  file: string;
  session: string;
}
interface CurrentEntry extends FileEntry {
  id: string;
  sig: string;
  mtime: number;
}
interface Snapshot {
  files: FileEntry[];
  inaccessible: number;
  discovered: number;
  traversalLimited: boolean;
  blocked: number;
  unverifiable: number;
}
interface EntryState {
  sig?: string;
  partial?: boolean;
  blocked?: string;
  attemptedAt?: number;
}
interface State {
  version: number;
  entries: Record<string, EntryState>;
  pendingQueue?: string[];
}
type SingleInput = Input & { archiveRoot?: undefined };
type CombinedInput = Input & { archiveRoot: string; source: "codex" };
interface CollectorResult {
  skippedForCapacity: boolean;
  baseline: boolean;
  skippedForBackfill: boolean;
  discovered: number;
  sessionsAttempted: number;
  sessionsFailed: number;
  itemsImported: number;
  pending: number;
  blocked: number;
  inaccessible: number;
  traversalLimited: boolean;
  unverifiable?: number;
  queueOverflow?: number;
}
type Ingest = (
  op: Operation,
  input: Input & { file: string; session: string; collectorLookback: number },
) => Promise<{
  itemsImported?: number;
  partial?: boolean;
  progressed?: boolean;
}>;
function hasCheckpoint(op: Operation): op is CombinedOperation {
  return typeof op.archive.getCheckpoint === "function";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isCollectorState(value: unknown): value is State {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.entries) ||
    Object.keys(value.entries).length > MAX_TRACKED_IDENTITIES ||
    (value.pendingQueue !== undefined &&
      (!Array.isArray(value.pendingQueue) ||
        value.pendingQueue.length > MAX_TRACKED_IDENTITIES ||
        value.pendingQueue.some(
          (id: unknown) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id),
        ) ||
        new Set(value.pendingQueue).size !== value.pendingQueue.length))
  )
    return false;
  return Object.values(value.entries).every(
    (entry) =>
      isRecord(entry) &&
      (entry.sig === undefined || typeof entry.sig === "string") &&
      (entry.partial === undefined || typeof entry.partial === "boolean") &&
      (entry.blocked === undefined || typeof entry.blocked === "string") &&
      (entry.attemptedAt === undefined ||
        typeof entry.attemptedAt === "number"),
  );
}
const errorCode = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code;
function collectChanged(
  op: Operation,
  input: SingleInput,
  ingest: Ingest,
): Promise<CollectorResult>;
function collectChanged(
  op: CombinedOperation,
  input: CombinedInput,
  ingest: Ingest,
): Promise<CollectorResult>;
async function collectChanged(
  op: Operation,
  input: Input,
  ingest: Ingest,
): Promise<CollectorResult> {
  if (
    !input.root ||
    !input.instance ||
    !["codex", "dsh"].includes(input.source)
  )
    throw new Error("Invalid collector source");
  const limit =
    input["max-sessions"] === undefined ? 3 : Number(input["max-sessions"]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Invalid collector limit");
  const cap =
    input["max-archive-mib"] === undefined
      ? 128
      : Number(input["max-archive-mib"]);
  if (!Number.isFinite(cap) || cap < 1 || cap > 65536)
    throw new Error("Invalid collector capacity");
  const atCapacity = async () => {
    try {
      return (
        (
          await fs.stat(
            op.archive.indexFile || path.join(op.archive.dir, "archive.json"),
          )
        ).size >=
        cap * 1024 * 1024
      );
    } catch (e) {
      if (errorCode(e) === "ENOENT") return false;
      throw e;
    }
  };
  const empty = {
    skippedForCapacity: false,
    baseline: false,
    skippedForBackfill: false,
    discovered: 0,
    sessionsAttempted: 0,
    sessionsFailed: 0,
    itemsImported: 0,
    pending: 0,
    blocked: 0,
    inaccessible: 0,
    traversalLimited: false,
  };
  const backfillMarker = "historical-backfill-pass-v1.json.lock";
  try {
    await fs.lstat(path.join(op.archive.dir, backfillMarker));
    try {
      // A successful probe can recover a known marker left by a killed writer.
      await withWriterLock(
        op.archive.dir,
        "historical-backfill-pass-v1",
        () => {},
        { legacyLock: backfillMarker, timeoutMs: 0 },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Writer lock wait timed out"
      )
        return { ...empty, skippedForBackfill: true };
      throw error;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const root = await fs.realpath(input.root);
  const sourceId = hash(
    JSON.stringify([
      op.scope.owner,
      op.scope.project,
      input.source,
      input.instance,
      root,
    ]),
  );
  const stateFile = path.join(op.archive.dir, `collector-${sourceId}.json`);
  return withWriterLock(op.archive.dir, `collector:${sourceId}`, async () => {
    let snapshot: Snapshot;
    if (input.archiveRoot === undefined) {
      snapshot = await discoverIntakeSources(
        op,
        { ...input, archiveRoot: undefined },
        root,
      );
    } else {
      if (input.source !== "codex" || !input.archiveRoot)
        throw new Error("Archive root requires Codex source");
      if (!hasCheckpoint(op))
        throw new Error("Archive root requires checkpoint lookup");
      snapshot = await discoverIntakeSources(
        op,
        { ...input, source: "codex", archiveRoot: input.archiveRoot },
        root,
      );
    }
    const current: CurrentEntry[] = [];
    let inaccessible = snapshot.inaccessible;
    for (const entry of snapshot.files) {
      try {
        const st = await fs.lstat(entry.file);
        if (!st.isFile() || st.isSymbolicLink())
          throw new Error("source changed");
        current.push({
          ...entry,
          id: hash(entry.session),
          sig: signature(st),
          mtime: st.mtimeMs,
        });
      } catch {
        inaccessible++;
      }
    }
    let state: State | undefined;
    try {
      const st = await fs.lstat(stateFile);
      if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
        throw new Error("Invalid collector state");
      const parsed: unknown = JSON.parse(await fs.readFile(stateFile, "utf8"));
      if (!isCollectorState(parsed)) throw new Error("Invalid collector state");
      state = parsed;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    async function save() {
      const tmp = `${stateFile}.${crypto.randomUUID()}.tmp`;
      try {
        const f = await fs.open(tmp, "wx", 0o600);
        try {
          await f.writeFile(JSON.stringify(state));
          await f.sync();
        } finally {
          await f.close();
        }
        await fs.rename(tmp, stateFile);
      } finally {
        await fs.rm(tmp, { force: true });
      }
    }
    const result: CollectorResult = {
      ...empty,
      discovered: snapshot.discovered,
      inaccessible,
      traversalLimited: snapshot.traversalLimited,
      blocked: snapshot.blocked,
      unverifiable: snapshot.unverifiable,
    };
    if (!state) {
      if (new Set(current.map((e) => e.id)).size > MAX_TRACKED_IDENTITIES)
        throw new Error("Collector baseline exceeds identity capacity");
      state = {
        version: 1,
        entries: Object.fromEntries(current.map((e) => [e.id, { sig: e.sig }])),
      };
      await save();
      result.baseline = true;
      return result;
    }
    const establishedState = state;
    const before = JSON.stringify(establishedState);
    const complete =
      !snapshot.traversalLimited &&
      !inaccessible &&
      !snapshot.unverifiable &&
      !snapshot.blocked;
    const visible = new Map(current.map((entry) => [entry.id, entry]));
    if (complete) {
      for (const id of Object.keys(establishedState.entries))
        if (!visible.has(id)) delete establishedState.entries[id];
    }
    const eligible = (entry: CurrentEntry) => {
      const old = establishedState.entries[entry.id];
      return (
        !old ||
        ((old.sig !== entry.sig || old.partial) && old.blocked !== entry.sig)
      );
    };
    const pending = current.filter(eligible);
    pending.sort(
      (a, b) =>
        (establishedState.entries[a.id]?.attemptedAt || 0) -
          (establishedState.entries[b.id]?.attemptedAt || 0) ||
        b.mtime - a.mtime,
    );
    // Older binaries can add entries without maintaining the queue. Keep entry
    // identities first when reconciling a union that exceeds the capacity.
    const admitted = new Set(Object.keys(establishedState.entries));
    const queue: string[] = [];
    for (const id of establishedState.pendingQueue || []) {
      const entry = visible.get(id);
      if ((!entry && complete) || (entry && !eligible(entry))) continue;
      if (!admitted.has(id) && admitted.size >= MAX_TRACKED_IDENTITIES)
        continue;
      admitted.add(id);
      queue.push(id);
    }
    const queued = new Set(queue);
    let queueOverflow = 0;
    for (const entry of pending) {
      if (queued.has(entry.id)) continue;
      if (!admitted.has(entry.id) && admitted.size >= MAX_TRACKED_IDENTITIES) {
        queueOverflow++;
        continue;
      }
      admitted.add(entry.id);
      queued.add(entry.id);
      queue.push(entry.id);
    }
    if (queueOverflow) result.queueOverflow = queueOverflow;
    establishedState.pendingQueue = queue;
    if (JSON.stringify(establishedState) !== before) await save();
    result.pending = pending.length;
    const selected = queue
      .flatMap((id) => {
        const entry = visible.get(id);
        return entry && eligible(entry) ? [entry] : [];
      })
      .slice(0, limit);
    for (const entry of selected) {
      if (await atCapacity()) {
        result.skippedForCapacity = true;
        break;
      }
      result.sessionsAttempted++;
      const attemptedAt = Date.now();
      try {
        const stats = await ingest(op, {
          ...input,
          file: entry.file,
          session: entry.session,
          collectorLookback: 3,
        });
        result.itemsImported += stats.itemsImported || 0;
        const after = await fs.lstat(entry.file);
        const sig = signature(after);
        const old = establishedState.entries[entry.id] || {};
        if (sig !== entry.sig)
          establishedState.entries[entry.id] = {
            ...old,
            partial: true,
            attemptedAt,
          };
        else if (stats.partial && stats.progressed)
          establishedState.entries[entry.id] = {
            ...old,
            partial: true,
            attemptedAt,
          };
        else if (stats.partial)
          establishedState.entries[entry.id] = {
            ...old,
            partial: true,
            blocked: sig,
            attemptedAt,
          };
        else establishedState.entries[entry.id] = { sig, attemptedAt };
      } catch (error) {
        result.sessionsFailed++;
        const old = establishedState.entries[entry.id] || {};
        establishedState.entries[entry.id] = {
          ...old,
          attemptedAt,
          ...(errorCode(error) === "COLLECTOR_BATCH_LIMIT"
            ? { blocked: entry.sig }
            : {}),
        };
      }
      const index = queue.indexOf(entry.id);
      if (index !== -1) queue.splice(index, 1);
      if (eligible(entry)) queue.push(entry.id);
      // Persist outside the ingest catch so a write failure aborts the run.
      await save();
    }
    result.pending = current.filter((e) => {
      const old = establishedState.entries[e.id];
      return !old || old.sig !== e.sig || old.partial;
    }).length;
    result.blocked =
      snapshot.blocked +
      current.filter((e) => establishedState.entries[e.id]?.blocked === e.sig)
        .length;
    return result;
  });
}
module.exports = { collectChanged };
