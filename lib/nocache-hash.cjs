"use strict";
// Model bytes remain on a dedicated descriptor; the isolated child emits only a digest.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const SANDBOX = "/usr/bin/sandbox-exec";
const PYTHON = "/usr/bin/python3";
const SHASUM = "/usr/bin/shasum";
const PERL = "/usr/bin/perl";
const HELPER = path.join(__dirname, "nocache-hash.py");
const MAX_PREPARE_MS = 120000;
function failure(code) {
  return Object.assign(new Error("Isolated model hashing failed"), {
    code,
    safeLocal: true,
  });
}
function same(a, b) {
  return [
    "dev",
    "ino",
    "size",
    "mtimeMs",
    "ctimeMs",
    "mode",
    "uid",
    "gid",
  ].every((k) => a[k] === b[k]);
}
function validateHelperResult(value, expectedSize) {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      [
        "bytes",
        "digest",
        "hashesAgree",
        "nocache",
        "offset",
        "sandboxVerified",
        "version",
      ]
        .sort()
        .join(",") ||
    value.version !== 1 ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    value.bytes !== expectedSize ||
    value.offset !== expectedSize ||
    value.sandboxVerified !== true ||
    value.nocache !== true ||
    value.hashesAgree !== true
  )
    throw failure("MODEL_NOCACHE_FAILED");
  return value.digest;
}
async function capture(
  file,
  noSymlink = false,
  changeCode = "EXECUTABLE_CHANGED",
) {
  const link = await fsp.lstat(file);
  if (noSymlink && link.isSymbolicLink()) throw failure(changeCode);
  const resolved = await fsp.realpath(file),
    target = await fsp.lstat(resolved);
  if (!target.isFile() || target.isSymbolicLink())
    throw failure("MODEL_NOCACHE_FAILED");
  return { file, resolved, link, target, noSymlink, changeCode };
}
async function check(old) {
  const current = await capture(old.file, old.noSymlink, old.changeCode);
  if (
    current.resolved !== old.resolved ||
    !same(current.link, old.link) ||
    !same(current.target, old.target)
  )
    throw failure(old.changeCode);
}
function runIsolated(
  { profile, helper, canary, fd, cwd, timeout, signal },
  adapter,
) {
  return new Promise((resolve, reject) => {
    let child,
      timer,
      killTimer,
      settleTimer,
      outBytes = 0,
      errBytes = 0,
      reason,
      out = "",
      err = "",
      settled = false;
    const killGroup = (sig) => {
      if (!Number.isInteger(child?.pid)) return;
      try {
        if (adapter) adapter.kill(-child.pid, sig);
        else process.kill(-child.pid, sig);
      } catch (error) {
        if (error.code !== "ESRCH") reason ||= "MODEL_NOCACHE_FAILED";
      }
    };
    const stop = (code) => {
      if (reason) return;
      reason = code;
      killGroup("SIGTERM");
      killTimer = (adapter?.setTimeout || setTimeout)(
        () => killGroup("SIGKILL"),
        500,
      );
      settleTimer = (adapter?.setTimeout || setTimeout)(() => {
        killGroup("SIGKILL");
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref?.();
        done(failure(reason));
      }, 2000);
    };
    const abort = () => stop("CANCELLED");
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      (adapter?.clearTimeout || clearTimeout)(timer);
      (adapter?.clearTimeout || clearTimeout)(killTimer);
      (adapter?.clearTimeout || clearTimeout)(settleTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    if (signal?.aborted) return done(failure("CANCELLED"));
    try {
      child = (adapter?.spawn || spawn)(
        SANDBOX,
        ["-p", profile, PYTHON, "-I", helper, canary],
        {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe", fd],
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C",
            PYTHONDONTWRITEBYTECODE: "1",
          },
        },
      );
    } catch {
      return done(failure("MODEL_NOCACHE_FAILED"));
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (part) => {
      outBytes += part.length;
      if (outBytes > 1024) return stop("MODEL_NOCACHE_FAILED");
      out += part.toString();
    });
    child.stderr.on("data", (part) => {
      errBytes += part.length;
      if (errBytes > 4096) return stop("MODEL_NOCACHE_FAILED");
      err += part.toString();
    });
    child.on("error", () => {
      stop("MODEL_NOCACHE_FAILED");
    });
    child.on("close", (code) => {
      if (reason) return done(failure(reason));
      if (code !== 0) {
        let reported;
        try {
          reported = JSON.parse(err.trim().split("\n").at(-1)).error;
        } catch {
          reported = null;
        }
        const allowed = [
          "MODEL_NOCACHE_UNAVAILABLE",
          "MODEL_NOCACHE_FAILED",
          "MODEL_CHANGED",
          "SANDBOX_UNVERIFIED",
        ];
        return done(
          failure(
            allowed.includes(reported) ? reported : "MODEL_NOCACHE_FAILED",
          ),
        );
      }
      try {
        return done(null, JSON.parse(out));
      } catch {
        return done(failure("MODEL_NOCACHE_FAILED"));
      }
    });
    timer = (adapter?.setTimeout || setTimeout)(
      () => stop("MODEL_NOCACHE_TIMEOUT"),
      Math.max(1, timeout),
    );
  });
}
async function hashNoCache({ file, expectedSize, signal } = {}) {
  if (signal?.aborted) throw failure("CANCELLED");
  if (process.platform !== "darwin") throw failure("LOCAL_UNSUPPORTED");
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0
  )
    throw failure("INVALID_INPUT");
  const deadline = performance.now() + MAX_PREPARE_MS;
  let handle, scratch;
  try {
    const initial = await fsp.lstat(file);
    if (
      !initial.isFile() ||
      initial.isSymbolicLink() ||
      initial.size !== expectedSize
    )
      throw failure("MODEL_INVALID");
    const snapshots = await Promise.all([
      capture(file, true, "MODEL_CHANGED"),
      capture(HELPER, true),
      capture(PYTHON),
      capture(SHASUM),
      capture(PERL),
      capture(SANDBOX),
    ]);
    const model = snapshots[0];
    if (!same(model.link, initial)) throw failure("MODEL_CHANGED");
    if (signal?.aborted) throw failure("CANCELLED");
    handle = await fsp.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    if (!same(await handle.stat(), model.link)) throw failure("MODEL_CHANGED");
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-hash-"));
    await fsp.chmod(scratch, 0o700);
    const canary = path.join(scratch, "canary");
    await fsp.writeFile(canary, "synthetic denial probe", {
      mode: 0o600,
      flag: "wx",
    });
    const denied = [
      ...new Set([
        "/Users",
        os.homedir(),
        "/private/tmp",
        "/tmp",
        "/private/var/folders",
        "/var/folders",
        "/Volumes",
      ]),
    ];
    const allowed = [
      ...new Set([file, model.resolved, HELPER, snapshots[1].resolved]),
    ];
    const profile =
      "(version 1)(allow default)(deny network*)(deny file-write*)" +
      "(deny file-read* " +
      denied.map((x) => "(subpath " + JSON.stringify(x) + ")").join("") +
      ")" +
      "(allow file-read* " +
      allowed.map((x) => "(literal " + JSON.stringify(x) + ")").join("") +
      ")";
    if (signal?.aborted) throw failure("CANCELLED");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw failure("MODEL_NOCACHE_TIMEOUT");
    const output = await runIsolated({
      profile,
      helper: HELPER,
      canary,
      fd: handle.fd,
      cwd: scratch,
      timeout: remaining,
      signal,
    });
    const digest = validateHelperResult(output, expectedSize);
    if (!same(await handle.stat(), model.link)) throw failure("MODEL_CHANGED");
    for (const entry of snapshots) await check(entry);
    if (signal?.aborted) throw failure("CANCELLED");
    if (performance.now() >= deadline) throw failure("MODEL_NOCACHE_TIMEOUT");
    return {
      fingerprint: "sha256:" + digest,
      identity: {
        dev: model.link.dev,
        ino: model.link.ino,
        size: model.link.size,
        mtimeMs: model.link.mtimeMs,
        ctimeMs: model.link.ctimeMs,
        mode: model.link.mode,
        resolved: model.resolved,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw failure("CANCELLED");
    throw error?.safeLocal ? error : failure("MODEL_NOCACHE_FAILED");
  } finally {
    await handle?.close();
    if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
  }
}
function runIsolatedForTest(options, adapter) {
  if (
    !adapter ||
    typeof adapter.spawn !== "function" ||
    typeof adapter.kill !== "function" ||
    typeof adapter.setTimeout !== "function" ||
    typeof adapter.clearTimeout !== "function"
  )
    throw failure("INVALID_INPUT");
  return runIsolated(options, adapter);
}
module.exports = { hashNoCache, validateHelperResult, runIsolatedForTest };
