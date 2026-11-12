import * as fs from "node:fs/promises";
import { createRequire } from "node:module";

const load = createRequire(__filename);
type Harness = "codex" | "dsh";
interface Identity {
  harness: string;
  instance: string;
  session: string;
}
interface Scope {
  owner: string;
  project: string;
}
interface Entry {
  file: string;
  session: string;
}
interface Input {
  source: Harness;
  instance: string;
  file?: string;
  session?: string;
  root?: string;
  [key: string]: unknown;
}
interface Item {
  id: string;
  revision: string;
  metadata?: {
    coordinate?: unknown;
    original?: {
      availability?: unknown;
      reason?: unknown;
      coordinate?: unknown;
    };
  };
}
interface Prior {
  item: Item;
  source: Identity;
}
interface Checkpoint {
  position: number;
  source: Identity & { coverage?: unknown };
}
interface Result {
  imported: number;
  replayed: boolean;
}
interface Operation {
  scope: Scope;
  archive: {
    dir: string;
    getItem(
      input: Scope & { id: string; revision: string },
    ): Promise<Prior | null>;
    getCheckpoint(input: Scope & Identity): Promise<Checkpoint | null>;
    importBatch(batch: unknown): Promise<Result>;
  };
}
const { readCodex, readDsh, sourceIdentity } = load("../adapters") as {
  readCodex: (input: Record<string, unknown>) => AsyncIterable<unknown>;
  readDsh: (input: Record<string, unknown>) => AsyncIterable<unknown>;
  sourceIdentity: (input: Identity) => Identity;
};
const { discoverIntakeSources } = load("../codex-discovery.cjs") as {
  discoverIntakeSources: (
    op: Operation,
    input: Input,
    root: string,
  ) => Promise<{ files: Entry[] }>;
};
const { originalCapture } = load("../originals.cjs") as {
  originalCapture: (dir: string) => unknown;
};
function validInput(value: unknown): value is Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    (input.source === "codex" || input.source === "dsh") &&
    typeof input.instance === "string" &&
    input.instance.length > 0
  );
}

// This records current bytes as a new observation; it does not verify the historical bytes.
export async function repairOriginal(
  op: Operation,
  manifest: unknown,
  id: string,
  revision: string,
): Promise<{
  status: string;
  coordinate: number;
  itemsImported: number;
  replayed: boolean;
}> {
  if (!Array.isArray(manifest) || manifest.length > 200 || !id || !revision)
    throw Error("Invalid targeted repair input");
  const prior = await op.archive.getItem({ ...op.scope, id, revision });
  const original = prior?.item?.metadata?.original;
  const coordinate = prior?.item?.metadata?.coordinate;
  if (
    !prior ||
    original?.availability !== "source-only" ||
    original.reason !== "record-size-limit" ||
    typeof coordinate !== "number" ||
    !Number.isSafeInteger(coordinate) ||
    coordinate < 1 ||
    original.coordinate !== coordinate
  )
    throw Error("Target is not an eligible source-only original");
  const candidates: Array<Input & Entry & { identity: Identity }> = [];
  for (const input of manifest as unknown[]) {
    if (!validInput(input) || input.source !== prior.source.harness) continue;
    const entries =
      typeof input.file === "string" &&
      typeof input.session === "string" &&
      input.file &&
      input.session
        ? [{ file: input.file, session: input.session }]
        : typeof input.root === "string" && input.root
          ? (
              await discoverIntakeSources(
                op,
                input,
                await fs.realpath(input.root),
              )
            ).files
          : [];
    for (const entry of entries) {
      const identity = sourceIdentity({
        harness: input.source,
        instance: input.instance,
        session: entry.session,
      });
      if (
        (["harness", "instance", "session"] as const).every(
          (k) => identity[k] === prior.source[k],
        )
      )
        candidates.push({ ...input, ...entry, identity });
    }
  }
  if (candidates.length !== 1)
    throw Error("Configured target source is unavailable or ambiguous");
  const target = candidates[0];
  if (!target)
    throw Error("Configured target source is unavailable or ambiguous");
  const checkpoint = await op.archive.getCheckpoint({
    ...op.scope,
    ...target.identity,
  });
  if (!checkpoint || coordinate > checkpoint.position)
    throw Error("Target is outside the verified checkpoint");
  const read = target.source === "codex" ? readCodex : readDsh;
  const before = await fs.lstat(target.file);
  if (!before.isFile() || before.isSymbolicLink())
    throw Error("Target source is not a regular file");
  let result: Result | undefined;
  for await (const batch of read({
    ...op.scope,
    harness: target.source,
    instance: target.instance,
    session: target.session,
    file: target.file,
    checkpoint,
    targetCoordinate: coordinate,
    targetItem: prior.item,
    captureOriginal: originalCapture(op.archive.dir),
  })) {
    const after = await fs.lstat(target.file);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      (["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const).some(
        (k) => before[k] !== after[k],
      )
    )
      throw Error("Target source changed during capture");
    result = await op.archive.importBatch(batch);
  }
  if (!result) throw Error("Target was not captured");
  return {
    status: "captured-current-observation",
    coordinate,
    itemsImported: result.imported,
    replayed: result.replayed,
  };
}
