"use strict";
// Compare the full source fraction without rounding or changing stored text.
function sourceInstant(value: unknown): { ms: number; tail: string } | null {
  if (typeof value !== "string") return null;
  const m =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(
      value,
    );
  if (!m) return null;
  const [, ys, mos, ds, hs, mins, ss, fraction, zone] = m;
  const y = Number(ys),
    mo = Number(mos),
    d = Number(ds),
    h = Number(hs),
    min = Number(mins),
    s = Number(ss);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || min > 59 || s > 59) return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, mo - 1, d);
  calendar.setUTCHours(0, 0, 0, 0);
  if (
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== mo - 1 ||
    calendar.getUTCDate() !== d
  )
    return null;
  if (
    zone !== "Z" &&
    (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59)
  )
    return null;
  const msFraction = (fraction || "").slice(0, 3).padEnd(3, "0");
  const n = Date.parse(
    `${ys}-${mos}-${ds}T${hs}:${mins}:${ss}.${msFraction}${zone}`,
  );
  return Number.isFinite(n)
    ? { ms: n, tail: (fraction || "").slice(3).replace(/0+$/, "") }
    : null;
}
export function compareBound(value: unknown, bound: string): number | null {
  if (sourceInstant(value) === null || sourceInstant(bound) === null)
    return null;
  return compareTime(value, bound);
}
type Filters = {
  from?: string | undefined;
  to?: string | undefined;
  toExclusive?: boolean | undefined;
};
export function bounds(args: Filters): {
  from: string | null;
  to: string | null;
  exclusive: boolean;
} {
  function parse(
    v: string | undefined,
    end: boolean,
  ): { value: string | null; exclusive: boolean } {
    if (v === undefined) return { value: null, exclusive: false };
    if (/^\d{4}-\d\d-\d\d$/.test(v)) {
      const start = v + "T00:00:00.000Z";
      const n = sourceInstant(start);
      if (n === null) throw new Error("Invalid date: " + v);
      const upper = end ? new Date(n.ms + 86400000).toISOString() : start;
      if (sourceInstant(upper) === null)
        throw new Error("Date upper boundary exceeds supported range: " + v);
      return {
        value: upper,
        exclusive: end,
      };
    }
    if (sourceInstant(v) === null)
      throw new Error("Invalid RFC3339 timestamp: " + v);
    return { value: v, exclusive: false };
  }
  const from = parse(args.from, false),
    to = parse(args.to, true);
  if (args.toExclusive && to.value !== null) to.exclusive = true;
  if (
    from.value !== null &&
    to.value !== null &&
    (compareTime(from.value, to.value) > 0 ||
      (to.exclusive && compareTime(from.value, to.value) === 0))
  )
    throw new Error("Invalid time range: from is after to");
  return { from: from.value, to: to.value, exclusive: to.exclusive };
}
export function matchesTime(value: unknown, args: Filters): boolean {
  const b = bounds(args);
  if (b.from === null && b.to === null) return true;
  const low = b.from === null ? 0 : compareBound(value, b.from);
  const high = b.to === null ? 0 : compareBound(value, b.to);
  return (
    low !== null &&
    high !== null &&
    low >= 0 &&
    (b.exclusive ? high < 0 : high <= 0)
  );
}
// Unknown values always follow known values, in either direction.
export function compareTime(
  a: unknown,
  b: unknown,
  descending = false,
): number {
  const x = sourceInstant(a),
    y = sourceInstant(b);
  if (x === null) return y === null ? 0 : 1;
  if (y === null) return -1;
  const result =
    x.ms === y.ms
      ? x.tail < y.tail
        ? -1
        : x.tail > y.tail
          ? 1
          : 0
      : x.ms < y.ms
        ? -1
        : 1;
  return descending ? -result : result;
}
