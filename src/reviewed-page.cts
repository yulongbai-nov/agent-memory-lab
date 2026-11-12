import { createHash } from "node:crypto";

function readCursor(cursor: unknown, binding: string): Record<string, unknown> {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new Error();
  const parsed: unknown = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error();
  const record = parsed as Record<string, unknown>;
  if (record.binding !== binding) throw new Error();
  return record;
}

type SqlitePosition = {
  after: [timeKey: string, kind: 0 | 1, itemId: string, sequence: number];
  snapshot: string;
};

function isSqlitePosition(position: unknown): position is SqlitePosition {
  if (position === null || typeof position !== "object") return false;
  const { after, snapshot } = position as Record<string, unknown>;
  if (!Array.isArray(after) || after.length !== 4) return false;
  const [timeKey, kind, itemId, sequence] = after as unknown[];
  return (
    typeof snapshot === "string" &&
    /^[a-f0-9]{64}$/.test(snapshot) &&
    typeof timeKey === "string" &&
    /^(?:0[0-9]{21}|1)$/.test(timeKey) &&
    typeof itemId === "string" &&
    ((kind === 0 && itemId.length > 0) || (kind === 1 && itemId === "")) &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence > 0
  );
}

export function parseReviewedSqliteCursor(
  cursor: unknown,
  binding: string,
): SqlitePosition | null {
  if (cursor === undefined) return null;
  let record: Record<string, unknown>;
  try {
    record = readCursor(cursor, binding);
  } catch (cause) {
    throw new Error("invalid reviewed timeline cursor", { cause });
  }
  // Old offset cursors need a reload into the SQLite ordering after upgrade.
  if (
    record.version === undefined &&
    typeof record.offset === "number" &&
    Number.isSafeInteger(record.offset) &&
    record.offset > 0 &&
    typeof record.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(record.fingerprint)
  )
    throw new Error("reviewed timeline cursor is stale");
  if (record.version !== 2 || !isSqlitePosition(record.position))
    throw new Error("invalid reviewed timeline cursor");
  return record.position;
}

export function encodeReviewedSqliteCursor(
  position: SqlitePosition | null,
  binding: string,
): string | null {
  if (position === null) return null;
  return Buffer.from(
    JSON.stringify({ version: 2, binding, position }),
  ).toString("base64url");
}

// Earlier task states and corrections can change when a review is appended.
// The caller supplies the ordered identities of the immutable inputs.
export function reviewedPage<T>(
  rows: T[],
  binding: string,
  limit: number,
  cursor: unknown,
  fingerprintInput: unknown,
): { rows: T[]; nextCursor: string | null } {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(fingerprintInput))
    .digest("hex");
  let offset = 0;
  if (cursor !== undefined) {
    try {
      const p = readCursor(cursor, binding);
      if (
        !Number.isSafeInteger(p.offset) ||
        (p.offset as number) < 1 ||
        typeof p.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(p.fingerprint)
      )
        throw new Error();
      offset = p.offset as number;
      if (p.fingerprint !== fingerprint) throw new Error("stale");
      if (offset >= rows.length) throw new Error();
    } catch (error) {
      if (error instanceof Error && error.message === "stale")
        throw new Error("reviewed timeline cursor is stale", { cause: error });
      throw new Error("invalid reviewed timeline cursor", { cause: error });
    }
  }
  const page = rows.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    rows: page,
    nextCursor:
      next < rows.length
        ? Buffer.from(
            JSON.stringify({ binding, offset: next, fingerprint }),
          ).toString("base64url")
        : null,
  };
}
