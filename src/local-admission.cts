"use strict";

type Status = "admitted" | "low" | "unavailable" | "timeout" | "cancelled";
type Outcome = {
  status: Status;
  samples: number;
  waitMs: number;
  lastPercent?: number;
};
type Options = {
  sample: (options: {
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<number>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  deadline: number;
  signal?: AbortSignal;
  waitLimitMs?: number;
  intervalMs?: number;
};
async function waitForAdmission({
  sample,
  now,
  sleep,
  deadline,
  signal,
  waitLimitMs = 15000,
  intervalMs = 1000,
}: Options): Promise<Outcome> {
  if (
    typeof sample !== "function" ||
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    !Number.isFinite(deadline) ||
    !Number.isFinite(waitLimitMs) ||
    waitLimitMs < 0 ||
    waitLimitMs > 15000 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > 1000
  )
    throw Error("Invalid admission policy");
  const start = now();
  if (!Number.isFinite(start)) throw Error("Invalid monotonic time");
  const waitDeadline = start + waitLimitMs;
  let samples = 0,
    lastPercent: number | undefined;
  const result = (status: Status): Outcome => ({
    status,
    samples,
    waitMs: Math.max(0, now() - start),
    ...(lastPercent === undefined ? {} : { lastPercent }),
  });
  for (;;) {
    if (signal?.aborted) return result("cancelled");
    let at = now();
    if (at >= deadline) return result("timeout");
    if (samples > 0 && at >= waitDeadline) return result("low");
    const remaining = Math.min(
      deadline - at,
      samples === 0 && waitLimitMs === 0 ? deadline - at : waitDeadline - at,
    );
    if (remaining <= 0) return result(at >= deadline ? "timeout" : "low");
    let value: number;
    try {
      samples++;
      const opts: { timeoutMs: number; signal?: AbortSignal } = {
        timeoutMs: Math.min(4000, remaining),
      };
      if (signal) opts.signal = signal;
      value = await sample(opts);
    } catch {
      if (signal?.aborted) return result("cancelled");
      return result(now() >= deadline ? "timeout" : "unavailable");
    }
    at = now();
    if (signal?.aborted) return result("cancelled");
    if (at >= deadline) return result("timeout");
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100
    )
      return result("unavailable");
    lastPercent = value;
    if (waitLimitMs > 0 && at >= waitDeadline) return result("low");
    if (value >= 45) return result("admitted");
    if (at >= waitDeadline) return result("low");
    const delay = Math.min(intervalMs, waitDeadline - at, deadline - at);
    if (delay <= 0) return result(at >= deadline ? "timeout" : "low");
    try {
      await sleep(delay, signal);
    } catch {
      if (signal?.aborted) return result("cancelled");
      return result(now() >= deadline ? "timeout" : "unavailable");
    }
  }
}
module.exports = { waitForAdmission };
