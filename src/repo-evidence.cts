import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify, TextDecoder } from "node:util";

const run = promisify(execFile);
const maxBlobBytes = 1024 * 1024;
const maxExcerptBytes = 8192;
const maxLines = 100;
const evidenceError = (message: string) =>
  Object.assign(new Error(message), { code: "REPO_EVIDENCE" });
const fullObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export async function readRepoEvidence(input: {
  root: string;
  commit: string;
  path: string;
  firstLine: number;
  lastLine: number;
  expectBlob?: string;
}) {
  const { commit, path, firstLine, lastLine, expectBlob } = input;
  if (
    !fullObjectId.test(commit) ||
    (expectBlob !== undefined && !fullObjectId.test(expectBlob))
  )
    throw evidenceError("A full Git object ID is required");
  if (
    !input.root ||
    !path ||
    Buffer.byteLength(path) > 4096 ||
    /[\\\p{Cc}]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw evidenceError(
      "A repository root and a repository-relative file path are required",
    );
  if (
    !Number.isSafeInteger(firstLine) ||
    !Number.isSafeInteger(lastLine) ||
    firstLine < 1 ||
    lastLine < firstLine ||
    lastLine - firstLine >= maxLines
  )
    throw evidenceError("Invalid evidence line range");
  const cwd = await realpath(input.root).catch(() => {
    throw evidenceError("Repository root is unavailable");
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)),
  );
  Object.assign(env, {
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
  });
  const git = async (args: string[], maxBuffer: number) => {
    try {
      return (
        await run("git", args, {
          cwd,
          env,
          encoding: "buffer",
          maxBuffer,
          timeout: 10000,
        })
      ).stdout;
    } catch {
      throw evidenceError("Git could not read the requested local object");
    }
  };
  if (
    (
      await git(["rev-parse", "--is-inside-work-tree", "--show-prefix"], 8192)
    ).toString() !== "true\n\n"
  )
    throw evidenceError("Select the Git worktree root");
  if (
    (await git(["rev-parse", "--verify", "--end-of-options", commit], 128))
      .toString()
      .trim() !== commit
  )
    throw evidenceError("The supplied commit ID could not be verified");
  if (
    (await git(["cat-file", "-t", commit], 128)).toString().trim() !== "commit"
  )
    throw evidenceError("The supplied object is not a Git commit");
  const entry = await git(
    ["ls-tree", "--full-tree", "-z", commit, "--", path],
    8192,
  );
  const separator = entry.indexOf(9);
  const [mode, type, blob] = entry.subarray(0, separator).toString().split(" ");
  if (
    separator < 0 ||
    entry.at(-1) !== 0 ||
    !entry.subarray(separator + 1, -1).equals(Buffer.from(path)) ||
    type !== "blob" ||
    !blob ||
    !fullObjectId.test(blob) ||
    !["100644", "100755"].includes(mode ?? "")
  )
    throw evidenceError("The commit has no regular file at that path");
  if (expectBlob !== undefined && expectBlob !== blob)
    throw evidenceError("Git blob does not match the reference");
  const size = Number(
    (await git(["cat-file", "-s", blob], 128)).toString().trim(),
  );
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBlobBytes)
    throw evidenceError("Git blob exceeds evidence limits or is empty");
  const bytes = await git(["cat-file", "blob", blob], maxBlobBytes);
  const objectId = createHash(blob.length === 40 ? "sha1" : "sha256")
    .update(`blob ${size}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== size || objectId !== blob)
    throw evidenceError("Git blob verification failed");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw evidenceError("Git evidence requires UTF-8 text");
  }
  if (text.includes("\0"))
    throw evidenceError("Git evidence requires UTF-8 text");
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  if (lastLine > lines.length)
    throw evidenceError("Git evidence line range is unavailable");
  const excerpt = lines.slice(firstLine - 1, lastLine).join("");
  if (Buffer.byteLength(excerpt) > maxExcerptBytes)
    throw evidenceError("Git excerpt exceeds the byte limit");
  return {
    reference: {
      kind: "git-blob" as const,
      commit,
      path,
      blob,
      firstLine,
      lastLine,
    },
    text: excerpt,
    sha256: createHash("sha256").update(excerpt).digest("hex"),
  };
}
