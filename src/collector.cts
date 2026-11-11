import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { discoverIntakeSources } = load("../codex-discovery.cjs") as {
  discoverIntakeSources: (
    op: Operation,
    input: Input,
    root: string,
  ) => Promise<Snapshot>;
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
interface Operation {
  scope: { owner: string; project: string };
  archive: { dir: string; indexFile?: string };
}
interface Input {
  root: string;
  instance: string;
  source: string;
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
}
type Ingest = (
  op: Operation,
  input: Input & { file: string; session: string; collectorLookback: number },
) => Promise<{
  itemsImported?: number;
  partial?: boolean;
  progressed?: boolean;
}>;
const errorCode = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code;
async function collectChanged(op: Operation, input: Input, ingest: Ingest) {
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
    const snapshot = await discoverIntakeSources(op, input, root);
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
      state = JSON.parse(await fs.readFile(stateFile, "utf8")) as State;
      if (
        state.version !== 1 ||
        !state.entries ||
        typeof state.entries !== "object" ||
        Array.isArray(state.entries) ||
        Object.keys(state.entries).length > 20000
      )
        throw new Error("Invalid collector state");
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
    const result = {
      ...empty,
      discovered: snapshot.discovered,
      inaccessible,
      traversalLimited: snapshot.traversalLimited,
      blocked: snapshot.blocked,
      unverifiable: snapshot.unverifiable,
    };
    if (!state) {
      state = {
        version: 1,
        entries: Object.fromEntries(current.map((e) => [e.id, { sig: e.sig }])),
      };
      await save();
      result.baseline = true;
      return result;
    }
    const establishedState = state;
    // Prune only after a complete scan; files that disappear from an incomplete scan retain their prior state.
    if (
      !snapshot.traversalLimited &&
      !inaccessible &&
      !snapshot.unverifiable &&
      !snapshot.blocked
    ) {
      const ids = new Set(current.map((e) => e.id));
      for (const id of Object.keys(establishedState.entries))
        if (!ids.has(id)) delete establishedState.entries[id];
    }
    const pending = current.filter((e) => {
      const old = establishedState.entries[e.id];
      return (
        !old || ((old.sig !== e.sig || old.partial) && old.blocked !== e.sig)
      );
    });
    pending.sort(
      (a, b) =>
        (establishedState.entries[a.id]?.attemptedAt || 0) -
          (establishedState.entries[b.id]?.attemptedAt || 0) ||
        b.mtime - a.mtime,
    );
    result.pending = pending.length;
    for (const entry of pending.slice(0, limit)) {
      if (await atCapacity()) {
        result.skippedForCapacity = true;
        break;
      }
      if (
        !establishedState.entries[entry.id] &&
        Object.keys(establishedState.entries).length >= 20000
      ) {
        result.sessionsFailed++;
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
        await save();
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
    }
    result.pending = current.filter((e) => {
      const old = establishedState.entries[e.id];
      return !old || old.sig !== e.sig || old.partial;
    }).length;
    result.blocked =
      snapshot.blocked +
      current.filter((e) => establishedState.entries[e.id]?.blocked === e.sig)
        .length;
    await save();
    return result;
  });
}
module.exports = { collectChanged };
