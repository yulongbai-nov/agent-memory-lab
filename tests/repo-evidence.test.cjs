"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const cli = path.resolve(__dirname, "../bin/memory.cjs");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return run("git", args, cwd);
}

function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-evidence-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "one", "same-name");
  const other = path.join(temp, "two", "same-name");
  for (const dir of [repo, other]) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "config", "user.name", "Synthetic Test");
    git(dir, "config", "user.email", "synthetic@example.invalid");
  }
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(
    path.join(repo, "docs", "unicode.txt"),
    "first\r\n你好 🌍\r\nlast\r\n",
  );
  fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0x61, 0, 0x62]));
  fs.writeFileSync(path.join(repo, "controls.txt"), "\ufefftext\u009b\u202e");
  fs.symlinkSync("docs/unicode.txt", path.join(repo, "link.txt"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "synthetic original");
  const commit = git(repo, "rev-parse", "HEAD");
  const blob = git(repo, "rev-parse", `${commit}:docs/unicode.txt`);
  fs.writeFileSync(path.join(other, "unrelated.txt"), "another repository\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "different repository");
  return { temp, repo, other, commit, blob };
}

function invoke(
  root,
  commit,
  file,
  first = "1",
  last = "1",
  extra = [],
  env = process.env,
) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "repo-evidence",
      "--root",
      root,
      "--commit",
      commit,
      "--path",
      file,
      "--first-line",
      String(first),
      "--last-line",
      String(last),
      ...extra,
    ],
    { encoding: "utf8", env },
  );
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function failure(result) {
  assert.notEqual(result.status, 0, `unexpected success: ${result.stdout}`);
}

test("extracts exact committed Unicode CRLF bytes and verifies the blob", (t) => {
  const { repo, commit, blob } = setup(t);
  const result = success(
    invoke(repo, commit, "docs/unicode.txt", 2, 3, ["--expect-blob", blob]),
  );
  const text = "你好 🌍\r\nlast\r\n";
  assert.deepEqual(result.reference, {
    kind: "git-blob",
    commit,
    path: "docs/unicode.txt",
    blob,
    firstLine: 2,
    lastLine: 3,
  });
  assert.equal(result.text, text);
  assert.equal(
    result.sha256,
    createHash("sha256").update(text, "utf8").digest("hex"),
  );
  assert.equal(
    result.text,
    git(repo, "show", `${commit}:docs/unicode.txt`)
      .split("\r\n")
      .slice(1)
      .join("\r\n") + "\r\n",
  );
});

test("reads the fixed commit through a linked worktree despite branch and dirty changes", (t) => {
  const { temp, repo, commit, blob } = setup(t);
  const worktree = path.join(temp, "linked");
  git(repo, "worktree", "add", "-qb", "later", worktree);
  fs.writeFileSync(
    path.join(worktree, "docs/unicode.txt"),
    "committed replacement\n",
  );
  git(worktree, "add", ".");
  git(worktree, "commit", "-qm", "later commit");
  fs.writeFileSync(
    path.join(worktree, "docs/unicode.txt"),
    "dirty replacement\n",
  );
  const result = success(invoke(worktree, commit, "docs/unicode.txt", 1, 1));
  assert.equal(result.reference.commit, commit);
  assert.equal(result.reference.blob, blob);
  assert.equal(result.text, "first\r\n");
});

test("does not confuse repositories with the same basename", (t) => {
  const { other, repo, commit } = setup(t);
  failure(invoke(other, commit, "docs/unicode.txt"));
  failure(
    invoke(other, commit, "docs/unicode.txt", 1, 1, [], {
      ...process.env,
      GIT_DIR: path.join(repo, ".git"),
      GIT_WORK_TREE: repo,
      GIT_OBJECT_DIRECTORY: path.join(repo, ".git", "objects"),
    }),
  );
});

test("keeps terminal controls escaped on the wire and retains exact bytes", (t) => {
  const { repo, commit } = setup(t);
  const response = invoke(repo, commit, "controls.txt");
  const parsed = success(response);
  assert.equal(parsed.text, "\ufefftext\u009b\u202e");
  assert.ok(
    !response.stdout.includes("\u009b") && !response.stdout.includes("\u202e"),
  );
  assert.equal(
    parsed.sha256,
    createHash("sha256").update(parsed.text).digest("hex"),
  );
});

test("requires a worktree root, not a repository metadata directory", (t) => {
  const { temp, repo, commit } = setup(t);
  const bare = path.join(temp, "bare.git");
  git(temp, "clone", "-q", "--bare", repo, bare);
  for (const root of [
    bare,
    path.join(repo, ".git"),
    path.join(repo, ".git", "objects"),
    path.join(repo, "docs"),
  ]) {
    const result = invoke(root, commit, "docs/unicode.txt");
    failure(result);
    assert.match(result.stderr, /worktree root/);
  }
});

test("rejects mismatched blobs, abbreviated commits, invalid paths and ranges", (t) => {
  const { repo, commit } = setup(t);
  const cases = [
    [
      commit,
      "docs/unicode.txt",
      1,
      1,
      ["--expect-blob", "0".repeat(commit.length)],
    ],
    [commit.slice(0, 8), "docs/unicode.txt", 1, 1, []],
    [commit, "../docs/unicode.txt", 1, 1, []],
    [commit, "/docs/unicode.txt", 1, 1, []],
    [commit, "missing.txt", 1, 1, []],
    [commit, "docs/unicode.txt", 0, 1, []],
    [commit, "docs/unicode.txt", 2, 1, []],
    [commit, "docs/unicode.txt", 1, 4, []],
    [commit, "docs/unicode.txt", "1x", 1, []],
    [commit, "docs", 1, 1, []],
    [commit, "link.txt", 1, 1, []],
    [commit, "binary.bin", 1, 1, []],
  ];
  for (const [revision, file, first, last, extra] of cases) {
    const result = invoke(repo, revision, file, first, last, extra);
    assert.notEqual(
      result.status,
      0,
      `accepted ${JSON.stringify([revision, file, first, last, extra])}: ${result.stdout}`,
    );
  }
});
