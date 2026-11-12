type Status =
  | "metadata-present"
  | "missing-locally"
  | "source-only"
  | "invalid-metadata"
  | "ambiguous"
  | "unrepresented"
  | "uncheckpointed";
type Input = { coordinate: number; itemId: string; original: unknown };
type Data = { checkpoint: unknown; snapshot: string; inputs: Input[] };
type Reference = Record<string, unknown>;
type Row = {
  coordinate: number;
  status: Status;
  versions: number;
  reasons?: string[];
};
const MAX_ORIGINAL_COVERAGE_VARIANTS = 4096;
const statuses: Status[] = [
  "metadata-present",
  "missing-locally",
  "source-only",
  "invalid-metadata",
  "ambiguous",
  "unrepresented",
  "uncheckpointed",
];
const knownReasons = new Set([
  "not-captured",
  "record-size-limit",
  "scan-byte-limit",
  "capture-not-configured",
  "unsupported-record-shape",
]);
const record = (value: unknown): value is Reference =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function validateOriginalCoverageWindow(first: unknown, last: unknown): void {
  if (
    typeof first !== "number" ||
    typeof last !== "number" ||
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(last) ||
    first < 1 ||
    last < first ||
    last - first >= 512
  )
    throw Error("Invalid coverage window");
}

async function auditOriginalCoverage(
  first: number,
  last: number,
  expectedSnapshot: string | undefined,
  data: Data,
  isArchivedReference: (ref: unknown) => boolean,
  observeLocal: (ref: unknown) => Promise<unknown>,
) {
  validateOriginalCoverageWindow(first, last);
  if (expectedSnapshot !== undefined && !validHash(expectedSnapshot))
    throw Error("Invalid coverage snapshot");
  if (
    !record(data) ||
    !validHash(data.snapshot) ||
    !Array.isArray(data.inputs) ||
    data.inputs.length > MAX_ORIGINAL_COVERAGE_VARIANTS
  )
    throw Error("Invalid coverage data");
  if (expectedSnapshot !== undefined && expectedSnapshot !== data.snapshot)
    throw Error("Stale coverage snapshot");
  if (
    !record(data.checkpoint) ||
    !Number.isSafeInteger(data.checkpoint.position) ||
    (data.checkpoint.position as number) < 0
  )
    throw Error("Checkpoint required");
  const position = data.checkpoint.position as number;
  const source = record(data.checkpoint.source) ? data.checkpoint.source : {};
  const coverage = record(source.coverage) ? source.coverage : {};
  const checkpoint = {
    position,
    coverageComplete:
      typeof coverage.complete === "boolean" ? coverage.complete : null,
    priorRangeUnverified:
      typeof coverage.priorRangeUnverified === "boolean"
        ? coverage.priorRangeUnverified
        : null,
  };
  const groups = new Map<number, Input[]>();
  for (const input of data.inputs) {
    if (
      !record(input) ||
      !Number.isSafeInteger(input.coordinate) ||
      typeof input.itemId !== "string" ||
      !input.itemId
    )
      throw Error("Invalid coverage input");
    if (input.coordinate < first || input.coordinate > Math.min(last, position))
      throw Error("Coverage input outside window");
    const group = groups.get(input.coordinate) || [];
    group.push(input);
    groups.set(input.coordinate, group);
  }
  const counts = Object.fromEntries(
    statuses.map((status) => [status, 0]),
  ) as Record<Status, number>;
  const rows: Row[] = [];
  for (let coordinate = first; coordinate <= last; coordinate++) {
    const group = groups.get(coordinate) || [];
    let status: Status;
    const reasons = new Set<string>();
    const ids = new Set(group.map((input) => input.itemId));
    const archived = new Map<string, unknown>();
    let invalid = false;
    for (const input of group) {
      const ref = input.original;
      if (ref === undefined || ref === null) {
        reasons.add("not-captured");
        continue;
      }
      if (
        !record(ref) ||
        (ref.coordinate !== undefined && ref.coordinate !== coordinate)
      ) {
        invalid = true;
        continue;
      }
      if (ref.availability === "source-only") {
        if (typeof ref.reason === "string" && knownReasons.has(ref.reason))
          reasons.add(ref.reason);
        continue;
      }
      if (isArchivedReference(ref)) {
        archived.set(JSON.stringify([ref.sha256, ref.bytes]), ref);
      } else invalid = true;
    }
    if (coordinate > position) status = "uncheckpointed";
    else if (!group.length) status = "unrepresented";
    else if (ids.size > 1 || archived.size > 1) status = "ambiguous";
    else if (invalid) status = "invalid-metadata";
    else if (archived.size) {
      const observed = await observeLocal(archived.values().next().value);
      status =
        record(observed) && observed.availability === "archived"
          ? "metadata-present"
          : "missing-locally";
    } else status = "source-only";
    counts[status]++;
    rows.push({
      coordinate,
      status,
      versions: group.length,
      ...(status === "source-only" && reasons.size
        ? { reasons: [...reasons].sort() }
        : {}),
    });
  }
  return {
    version: "original-coverage-v1" as const,
    snapshot: data.snapshot,
    first,
    last,
    checkpoint,
    counts,
    rows,
  };
}
export {
  auditOriginalCoverage,
  MAX_ORIGINAL_COVERAGE_VARIANTS,
  validateOriginalCoverageWindow,
};
