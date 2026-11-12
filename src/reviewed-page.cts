import { createHash } from "node:crypto";

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
      if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new Error();
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (!parsed || typeof parsed !== "object") throw new Error();
      const p = parsed as Record<string, unknown>;
      if (
        p.binding !== binding ||
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
