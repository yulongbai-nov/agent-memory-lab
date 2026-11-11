const safeReasons = [
  "INVALID_INPUT",
  "LOCAL_FAILED",
  "LOCAL_UNSUPPORTED",
  "LOCAL_VALIDATION_OR_CACHE_FAILED",
  "MODEL_CHANGED",
  "MODEL_INVALID",
  "MODEL_NOT_PREPARED",
  "MODEL_UNAVAILABLE",
  "SANDBOX_UNVERIFIED",
  "MEMORY_ADMISSION",
  "MEMORY_PRESSURE",
  "MEMORY_UNAVAILABLE",
  "RSS_LIMIT",
  "RSS_UNAVAILABLE",
  "TIME_LIMIT",
  "OUTPUT_LIMIT",
  "DIAGNOSTIC_LIMIT",
  "PROCESS_FAILED",
  "ORIGINAL_UNAVAILABLE",
  "INPUT_LIMIT",
  "OUTPUT_WRITE_FAILED",
] as const;
type Reason = (typeof safeReasons)[number];
type Ref = {
  source: { harness: string; instance: string; session: string };
  item: string;
  version: string;
};
type Job = {
  key: string;
  refs: Ref[];
  projectionDigest: string;
  attempts: number;
  retryAt: number;
  cacheKey?: string;
  reason?: Reason;
};
type State = {
  schemaVersion: 1;
  scopeKey: string;
  selectorVersion: string;
  promptVersion: string;
  rotation: number;
  jobs: Job[];
};
const reasons = new Set<Reason>(safeReasons);
const hex = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const label = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && Buffer.byteLength(x, "utf8") <= 1024;
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype;
function fields(
  x: unknown,
  required: string[],
  optional: string[] = [],
): x is Record<string, unknown> {
  return (
    record(x) &&
    required.every((k) => Object.hasOwn(x, k)) &&
    Object.keys(x).every((k) => required.includes(k) || optional.includes(k))
  );
}
function validRef(x: unknown): x is Ref {
  return (
    fields(x, ["source", "item", "version"]) &&
    fields(x.source, ["harness", "instance", "session"]) &&
    label(x.source.harness) &&
    label(x.source.instance) &&
    label(x.source.session) &&
    label(x.item) &&
    label(x.version)
  );
}
function validJob(x: unknown): x is Job {
  return (
    fields(
      x,
      ["key", "refs", "projectionDigest", "attempts", "retryAt"],
      ["cacheKey", "reason"],
    ) &&
    hex(x.key) &&
    hex(x.projectionDigest) &&
    Array.isArray(x.refs) &&
    x.refs.length >= 1 &&
    x.refs.length <= 5 &&
    x.refs.every(validRef) &&
    integer(x.attempts) &&
    integer(x.retryAt) &&
    (!Object.hasOwn(x, "cacheKey") || hex(x.cacheKey)) &&
    (!Object.hasOwn(x, "reason") ||
      (typeof x.reason === "string" && reasons.has(x.reason as Reason))) &&
    ((x.attempts === 0 && !Object.hasOwn(x, "reason")) ||
      (x.attempts > 0 && Object.hasOwn(x, "reason")))
  );
}
function validateState(value: unknown): State {
  if (
    !fields(value, [
      "schemaVersion",
      "scopeKey",
      "selectorVersion",
      "promptVersion",
      "rotation",
      "jobs",
    ]) ||
    value.schemaVersion !== 1 ||
    !hex(value.scopeKey) ||
    !label(value.selectorVersion) ||
    !label(value.promptVersion) ||
    !integer(value.rotation) ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 8 ||
    !value.jobs.every(validJob) ||
    value.rotation >= Math.max(value.jobs.length, 1) ||
    new Set(value.jobs.map((job: Job) => job.key)).size !== value.jobs.length
  )
    throw new Error("Invalid local draft state");
  return value as State;
}
function createState(input: {
  scopeKey: string;
  selectorVersion: string;
  promptVersion: string;
}): State {
  if (!fields(input, ["scopeKey", "selectorVersion", "promptVersion"]))
    throw new Error("Invalid local draft domain");
  return validateState({ schemaVersion: 1, ...input, rotation: 0, jobs: [] });
}
function copy(state: unknown): State {
  return structuredClone(validateState(state));
}
function sameRefs(a: Ref[], b: Ref[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        y !== undefined &&
        x.item === y.item &&
        x.version === y.version &&
        x.source.harness === y.source.harness &&
        x.source.instance === y.source.instance &&
        x.source.session === y.source.session
      );
    })
  );
}
function enqueue(
  state: unknown,
  job: unknown,
): { state: State; status: "added" | "duplicate" | "full" } {
  const next = copy(state);
  if (
    !validJob(job) ||
    job.attempts !== 0 ||
    job.retryAt !== 0 ||
    job.cacheKey !== undefined
  )
    throw new Error("Invalid new job");
  const old = next.jobs.find((x) => x.key === job.key);
  if (old) {
    if (
      old.projectionDigest !== job.projectionDigest ||
      !sameRefs(old.refs, job.refs)
    )
      throw new Error("Conflicting job identity");
    return { state: next, status: "duplicate" };
  }
  if (next.jobs.length === 8) return { state: next, status: "full" };
  next.jobs.push(structuredClone(job));
  return { state: next, status: "added" };
}
function nextDue(
  state: unknown,
  now: number,
): { state: State; job: Job | null } {
  const next = copy(state);
  if (!integer(now)) throw new Error("Invalid time");
  for (let i = 0; i < next.jobs.length; i++) {
    const index = (next.rotation + i) % next.jobs.length;
    const job = next.jobs[index];
    if (job && job.retryAt <= now) {
      next.rotation = (index + 1) % next.jobs.length;
      return { state: next, job: structuredClone(job) };
    }
  }
  return { state: next, job: null };
}
function find(state: State, key: string): Job {
  if (!hex(key)) throw new Error("Invalid job key");
  const job = state.jobs.find((x) => x.key === key);
  if (!job) throw new Error("Unknown job");
  return job;
}
function fail(state: unknown, key: string, now: number, reason: Reason): State {
  const next = copy(state),
    job = find(next, key);
  if (
    !integer(now) ||
    !reasons.has(reason) ||
    job.attempts >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("Invalid failure");
  const attempts = job.attempts + 1;
  const delay =
    attempts === 1
      ? 0
      : Math.min(300000, 1000 * 2 ** Math.min(attempts - 2, 9));
  if (!Number.isSafeInteger(now + delay)) throw new Error("Invalid retry time");
  job.attempts = attempts;
  job.retryAt = now + delay;
  job.reason = reason;
  return next;
}
function bindCache(state: unknown, key: string, cacheKey: string): State {
  const next = copy(state),
    job = find(next, key);
  if (
    !hex(cacheKey) ||
    (job.cacheKey !== undefined && job.cacheKey !== cacheKey)
  )
    throw new Error("Invalid cache binding");
  job.cacheKey = cacheKey;
  return next;
}
// Caller must hold the scope lock and confirm that the exact old cache is absent.
// An invalid cache or a read error is not proof of absence. This function performs no I/O.
function rebindMissingCache(
  state: unknown,
  key: string,
  expectedOldKey: string,
  newKey: string,
): State {
  const next = copy(state),
    job = find(next, key);
  if (!hex(expectedOldKey) || !hex(newKey) || job.cacheKey !== expectedOldKey)
    throw new Error("Invalid missing cache rebind");
  job.cacheKey = newKey;
  return next;
}
function complete(state: unknown, key: string): State {
  const next = copy(state);
  find(next, key);
  const index = next.jobs.findIndex((x) => x.key === key);
  next.jobs.splice(index, 1);
  if (index < next.rotation) next.rotation--;
  if (next.rotation >= next.jobs.length) next.rotation = 0;
  return next;
}
module.exports = {
  createState,
  validateState,
  enqueue,
  nextDue,
  fail,
  bindCache,
  rebindMissingCache,
  complete,
};
