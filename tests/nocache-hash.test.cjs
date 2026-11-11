"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const {
  lstat,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  hashNoCache,
  runIsolatedForTest,
  validateHelperResult,
} = require("../lib/nocache-hash.cjs");

const digest = "0123456789abcdef".repeat(4);
function result(size) {
  return {
    version: 1,
    digest,
    bytes: size,
    offset: size,
    sandboxVerified: true,
    nocache: true,
    hashesAgree: true,
  };
}
const helperFailure = { code: "MODEL_NOCACHE_FAILED", safeLocal: true };

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4_321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let unrefCount = 0;
  child.unref = () => unrefCount++;
  const signals = [];
  const spawns = [];
  const timers = new Map();
  let clock = 0;
  let next = 0;
  const adapter = {
    spawn(...args) {
      spawns.push(args);
      return child;
    },
    kill(pid, signal) {
      signals.push([pid, signal]);
    },
    setTimeout(callback, ms) {
      const id = ++next;
      timers.set(id, { at: clock + ms, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    child,
    signals,
    spawns,
    unrefs: () => unrefCount,
    start(signal) {
      return runIsolatedForTest(
        {
          profile: "(version 1)",
          helper: "/synthetic/helper.py",
          canary: "/synthetic/canary",
          fd: 77,
          cwd: "/synthetic",
          timeout: 100,
          signal,
        },
        adapter,
      );
    },
    advance(ms) {
      const until = clock + ms;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (timer.at > until) break;
        clock = timer.at;
        timers.delete(id);
        timer.callback();
      }
      clock = until;
    },
  };
}

function assertOwnSignals(h) {
  assert.ok(h.signals.length > 0);
  assert.ok(h.signals.every(([group]) => group === -h.child.pid));
  assert.equal(h.signals[0][1], "SIGTERM");
  assert.ok(h.signals.some(([, signal]) => signal === "SIGKILL"));
}

test("the helper protocol accepts only a full, agreed and isolated digest", () => {
  for (const size of [0, 1, 65_537]) {
    assert.equal(validateHelperResult(result(size), size), digest);
  }
});

test("invalid metadata fails closed without accepting partial or unverified reads", () => {
  const size = 65_537;
  const valid = result(size);
  const { offset, ...missingOffset } = valid;
  assert.equal(offset, size);
  for (const value of [
    null,
    [],
    missingOffset,
    { ...valid, version: 2 },
    { ...valid, digest: digest.slice(1) },
    { ...valid, digest: "z".repeat(64) },
    { ...valid, bytes: size - 1 },
    { ...valid, bytes: String(size) },
    { ...valid, offset: size - 1 },
    { ...valid, sandboxVerified: false },
    { ...valid, nocache: false },
    { ...valid, hashesAgree: false },
    { ...valid, hashesAgree: "true" },
    { ...valid, unexpected: "synthetic extra field" },
  ]) {
    assert.throws(() => validateHelperResult(value, size), helperFailure);
  }
  for (const invalidSize of [
    -1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    String(size),
  ]) {
    assert.throws(
      () => validateHelperResult(valid, invalidSize),
      helperFailure,
    );
  }
});

test("the isolated runner uses a dedicated descriptor and preserves only known safe helper errors", async () => {
  const h = fakeChild();
  const pending = h.start();
  const [executable, args, options] = h.spawns[0];
  assert.equal(executable, "/usr/bin/sandbox-exec");
  assert.deepEqual(args, [
    "-p",
    "(version 1)",
    "/usr/bin/python3",
    "-I",
    "/synthetic/helper.py",
    "/synthetic/canary",
  ]);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe", 77]);
  assert.equal(options.detached, true);
  assert.deepEqual(Object.keys(options.env).sort(), [
    "LANG",
    "PATH",
    "PYTHONDONTWRITEBYTECODE",
  ]);
  const value = result(1);
  h.child.stdout.write(JSON.stringify(value));
  h.child.emit("close", 0);
  assert.deepEqual(await pending, value);
  h.advance(10_000);
  assert.deepEqual(h.signals, []);

  for (const [reported, expected] of [
    ["MODEL_NOCACHE_UNAVAILABLE", "MODEL_NOCACHE_UNAVAILABLE"],
    ["unrecognized synthetic detail", "MODEL_NOCACHE_FAILED"],
  ]) {
    const failed = fakeChild();
    const outcome = assert.rejects(failed.start(), {
      code: expected,
      safeLocal: true,
    });
    failed.child.stderr.write(JSON.stringify({ error: reported }));
    failed.child.emit("close", 1);
    await outcome;
    assert.equal(failed.spawns.length, 1);
  }
});

test("timeout settles a fake child that never closes and signals only its own group", async () => {
  const h = fakeChild();
  const outcome = assert.rejects(h.start(), {
    code: "MODEL_NOCACHE_TIMEOUT",
    safeLocal: true,
  });
  h.advance(99);
  assert.deepEqual(h.signals, []);
  h.advance(1);
  assert.deepEqual(h.signals, [[-h.child.pid, "SIGTERM"]]);
  h.advance(500);
  assert.deepEqual(h.signals.at(-1), [-h.child.pid, "SIGKILL"]);
  h.advance(1_500);
  await outcome;
  assertOwnSignals(h);
  assert.equal(h.child.stdout.destroyed, true);
  assert.equal(h.child.stderr.destroyed, true);
  assert.equal(h.unrefs(), 1);
});

test("abort and oversized output settle without an additional spawn", async () => {
  const controller = new AbortController();
  const aborted = fakeChild();
  const cancelled = assert.rejects(aborted.start(controller.signal), {
    code: "CANCELLED",
    safeLocal: true,
  });
  controller.abort();
  aborted.advance(2_000);
  await cancelled;
  assertOwnSignals(aborted);
  assert.equal(aborted.spawns.length, 1);

  for (const [stream, limit] of [
    ["stdout", 1_024],
    ["stderr", 4_096],
  ]) {
    const h = fakeChild();
    const outcome = assert.rejects(h.start(), helperFailure);
    h.child[stream].write(Buffer.alloc(limit, 0x61));
    assert.deepEqual(h.signals, []);
    h.child[stream].write(Buffer.from("b"));
    assert.deepEqual(h.signals, [[-h.child.pid, "SIGTERM"]]);
    h.advance(2_000);
    await outcome;
    assertOwnSignals(h);
    assert.equal(h.spawns.length, 1);
  }
});

const syntheticHelper = `
import contextlib, errno, hashlib, io, os, pathlib, stat, sys, types

namespace = {"__name__": "synthetic_nocache_fixture"}
helper = pathlib.Path(sys.argv[1])
exec(compile(helper.read_text(), str(helper), "exec"), namespace)
scenario = sys.argv[2]
raw = b"ab" if scenario == "short" else b"abc"
received = bytearray()
reads = offset = stat_calls = workers = 0
stdout_reads = 0

class Stream:
    def __init__(self, fd): self.fd = fd
    def fileno(self): return self.fd
    def close(self): pass

class Worker:
    stdin = Stream(9)
    stdout = Stream(10)
    def wait(self, **_): return 0
    def poll(self): return 0

def fake_stat(fd):
    global stat_calls
    assert fd == 3
    stat_calls += 1
    mtime = 2 if scenario == "changed" and stat_calls > 1 else 1
    return types.SimpleNamespace(
        st_dev=1, st_ino=2, st_size=3, st_mtime_ns=mtime, st_ctime_ns=1,
        st_mode=stat.S_IFREG | 0o600, st_uid=1, st_gid=1,
    )

def fake_read(fd, size):
    global reads, offset, stdout_reads
    if fd == 3:
        reads += 1
        part = raw[offset:offset + size]
        offset += len(part)
        return part
    assert fd == 10
    stdout_reads += 1
    if stdout_reads > 1:
        return b""
    hashed = b"different" if scenario == "mismatch" else received
    return hashlib.sha256(hashed).hexdigest().encode() + b" *-\\n"

def fake_fcntl(fd, op, *args):
    assert fd == 3
    if op == 1:
        return os.O_RDONLY
    assert op == 2 and args == (1,)
    if scenario == "flag":
        raise OSError(errno.ENOTSUP, "synthetic failure")
    return 0

def fake_worker(argv, **options):
    global workers
    workers += 1
    assert argv == ["/usr/bin/shasum", "-a", "256", "-b", "-"]
    assert options["close_fds"] is True
    return Worker()

def short_write(fd, view):
    assert fd == 9
    received.extend(view[:1])
    return 1

namespace.update(
    sys=types.SimpleNamespace(platform="darwin", argv=["helper", "canary"]),
    os=types.SimpleNamespace(
        fstat=fake_stat, read=fake_read, write=short_write,
        lseek=lambda fd, move, whence: offset,
        O_ACCMODE=os.O_ACCMODE, O_RDONLY=os.O_RDONLY, SEEK_CUR=os.SEEK_CUR,
    ),
    fcntl=types.SimpleNamespace(fcntl=fake_fcntl, F_GETFL=1, F_NOCACHE=2),
    select=types.SimpleNamespace(select=lambda read, *_: (read, [], [])),
    subprocess=types.SimpleNamespace(Popen=fake_worker, PIPE=-1),
    verify_sandbox=lambda canary: None,
)
expected = {
    "flag": "MODEL_NOCACHE_UNAVAILABLE",
    "short": "MODEL_CHANGED",
    "changed": "MODEL_CHANGED",
    "mismatch": "MODEL_NOCACHE_FAILED",
}[scenario]
visible = io.StringIO()
with contextlib.redirect_stdout(visible):
    try:
        namespace["main"]()
    except RuntimeError as error:
        assert str(error) == expected, str(error)
    else:
        raise AssertionError("unexpected successful helper")
assert visible.getvalue() == ""
if scenario == "flag":
    assert (reads, workers, offset) == (0, 0, 0)
else:
    assert (workers, offset, received) == (1, len(raw), raw)
`;

test("the Python helper fails before source I/O on a rejected flag and rejects invalid full-pass proofs", (t) => {
  const helper = require.resolve("../lib/nocache-hash.py");
  for (const scenario of ["flag", "short", "changed", "mismatch"]) {
    const child = spawnSync(
      "/usr/bin/python3",
      ["-I", "-c", syntheticHelper, helper, scenario],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { LANG: "C", PATH: "/usr/bin:/bin" },
      },
    );
    if (child.error?.code === "ENOENT")
      return t.skip("System Python is unavailable");
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, scenario + ": " + child.stderr);
    assert.equal(child.stdout, "");
  }
});

test(
  "the platform guard fails closed before looking for the model on non-macOS",
  {
    skip: process.platform === "darwin",
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "nocache-unsupported-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await assert.rejects(
      hashNoCache({ file: join(dir, "missing-model"), expectedSize: 1 }),
      { code: "LOCAL_UNSUPPORTED", safeLocal: true },
    );
  },
);

test("a pre-cancelled preparation has a safe cancellation result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nocache-cancel-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    hashNoCache({
      file: join(dir, "missing-model"),
      expectedSize: 1,
      signal: AbortSignal.abort(),
    }),
    { code: "CANCELLED", safeLocal: true },
  );
});

test(
  "macOS production entry hashes synthetic files through the isolated dual-SHA helper",
  {
    skip:
      process.platform !== "darwin" ||
      process.env.MEMLAB_TEST_DARWIN_NOCACHE !== "1",
    timeout: 30_000,
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "nocache-darwin-fixture-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const [index, data] of [
      Buffer.alloc(0),
      Buffer.from("abc"),
      Buffer.alloc(65_537, 0xab),
    ].entries()) {
      const file = join(dir, "synthetic-" + index);
      await writeFile(file, data, { mode: 0o600 });
      const before = await lstat(file);
      const value = await hashNoCache({ file, expectedSize: data.length });
      assert.equal(
        value.fingerprint,
        "sha256:" + createHash("sha256").update(data).digest("hex"),
      );
      assert.deepEqual(value.identity, {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        mode: before.mode,
        resolved: await realpath(file),
      });
      const after = await lstat(file);
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(after.ctimeMs, before.ctimeMs);
      assert.equal(after.mode, before.mode);
    }
    const alias = join(dir, "alias");
    await symlink(join(dir, "synthetic-1"), alias);
    await assert.rejects(hashNoCache({ file: alias, expectedSize: 3 }), {
      code: "MODEL_INVALID",
      safeLocal: true,
    });
  },
);
