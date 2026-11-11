"use strict";
// Ephemeral run identity; errors deliberately contain no file names or data.
const fs = require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:fs");
function same(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode
  );
}
async function identity(file, { noSymlink = false } = {}) {
  const link = await fs.lstat(file);
  if (noSymlink && link.isSymbolicLink()) throw Error("IDENTITY_CHANGED");
  const resolved = await fs.realpath(file),
    target = await fs.lstat(resolved);
  if (!target.isFile() || target.isSymbolicLink())
    throw Error("IDENTITY_CHANGED");
  return { file, resolved, link, target, noSymlink };
}
async function captureRunIdentity({
  model,
  binary,
  sandbox,
  promptFile,
  schemaFile,
  prompt,
  schema,
}) {
  if (
    ![model, binary, sandbox, promptFile, schemaFile].every(
      (x) => typeof x === "string" && path.isAbsolute(x),
    ) ||
    typeof prompt !== "string" ||
    typeof schema !== "string"
  )
    throw Error("INVALID_INPUT");
  const requests = [
    [model, true, "MODEL_CHANGED"],
    [binary, false, "EXECUTABLE_CHANGED"],
    [sandbox, false, "EXECUTABLE_CHANGED"],
    [promptFile, true, "CONFIG_CHANGED"],
    [schemaFile, true, "CONFIG_CHANGED"],
  ];
  const files = await Promise.all(
    requests.map(async ([file, noSymlink, reason]) => {
      try {
        return await identity(file, { noSymlink });
      } catch {
        throw Error(reason);
      }
    }),
  );
  const snap = {
    files,
    prompt: Buffer.from(prompt),
    schema: Buffer.from(schema),
  };
  await verifyRunIdentity(snap);
  return snap;
}
async function verifyRunIdentity(snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length !== 5 ||
    !Buffer.isBuffer(snapshot.prompt) ||
    !Buffer.isBuffer(snapshot.schema)
  )
    throw Error("INVALID_INPUT");
  for (let i = 0; i < snapshot.files.length; i++) {
    const old = snapshot.files[i];
    let next;
    try {
      next = await identity(old.file, { noSymlink: old.noSymlink });
    } catch {
      throw Error(
        i === 0
          ? "MODEL_CHANGED"
          : i < 3
            ? "EXECUTABLE_CHANGED"
            : "CONFIG_CHANGED",
      );
    }
    if (
      next.resolved !== old.resolved ||
      !same(next.link, old.link) ||
      !same(next.target, old.target)
    )
      throw Error(
        i === 0
          ? "MODEL_CHANGED"
          : i < 3
            ? "EXECUTABLE_CHANGED"
            : "CONFIG_CHANGED",
      );
    if (i >= 3) {
      if (next.link.mode & 0o077) throw Error("CONFIG_CHANGED");
      let handle;
      try {
        handle = await fs.open(
          next.file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const opened = await handle.stat();
        if (!opened.isFile() || !same(opened, next.link))
          throw Error("CONFIG_CHANGED");
        const data = await handle.readFile();
        if (!data.equals(i === 3 ? snapshot.prompt : snapshot.schema))
          throw Error("CONFIG_CHANGED");
      } catch {
        throw Error("CONFIG_CHANGED");
      } finally {
        await handle?.close();
      }
    }
  }
}
module.exports = { captureRunIdentity, verifyRunIdentity };
