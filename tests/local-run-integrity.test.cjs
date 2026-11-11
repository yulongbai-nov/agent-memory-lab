"use strict";

const assert = require("node:assert/strict");
const {
  chmod,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const {
  captureRunIdentity,
  verifyRunIdentity,
} = require("../lib/local-run-integrity.cjs");

async function syntheticRun(t) {
  const dir = await mkdtemp(join(tmpdir(), "synthetic-run-integrity-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const args = {
    model: join(dir, "model"),
    binary: join(dir, "binary"),
    sandbox: join(dir, "sandbox"),
    promptFile: join(dir, "prompt"),
    schemaFile: join(dir, "schema"),
    prompt: "Synthetic input.",
    schema: '{"type":"object"}',
  };
  const binaryTarget = join(dir, "binary-v1");
  await Promise.all([
    writeFile(args.model, "synthetic weights", { mode: 0o600 }),
    writeFile(binaryTarget, "synthetic binary", { mode: 0o700 }),
    writeFile(args.sandbox, "synthetic sandbox", { mode: 0o700 }),
    writeFile(args.promptFile, args.prompt, { mode: 0o600 }),
    writeFile(args.schemaFile, args.schema, { mode: 0o600 }),
  ]);
  await symlink(binaryTarget, args.binary);
  return { args, dir };
}

test("unchanged private input and a resolved executable alias revalidate", async (t) => {
  const { args } = await syntheticRun(t);
  const snapshot = await captureRunIdentity(args);
  await verifyRunIdentity(snapshot);
});

test("model, resolved binary and sandbox identity changes fail closed", async (t) => {
  for (const key of ["model", "binary", "sandbox"]) {
    await t.test(key, async (t) => {
      const { args, dir } = await syntheticRun(t);
      const snapshot = await captureRunIdentity(args);
      const replacement = join(dir, "replacement");
      await writeFile(replacement, "synthetic replacement", { mode: 0o700 });
      if (key === "binary") {
        await rm(args.binary);
        await symlink(replacement, args.binary);
      } else {
        await rename(replacement, args[key]);
      }
      await assert.rejects(verifyRunIdentity(snapshot));
    });
  }
});

test("different private prompt/schema bytes or public permissions fail closed", async (t) => {
  for (const [key, replacement] of [
    ["promptFile", "Synthetic input!"],
    ["schemaFile", '{"type":"number"}'],
    ["promptFile", null],
  ]) {
    await t.test(
      `${key} ${replacement === null ? "permission" : "bytes"}`,
      async (t) => {
        const { args } = await syntheticRun(t);
        const snapshot = await captureRunIdentity(args);
        if (replacement === null) await chmod(args[key], 0o644);
        else await writeFile(args[key], replacement);
        await assert.rejects(verifyRunIdentity(snapshot));
      },
    );
  }
});

test("model and private input paths reject symbolic links", async (t) => {
  for (const key of ["model", "promptFile", "schemaFile"]) {
    await t.test(key, async (t) => {
      const { args } = await syntheticRun(t);
      const original = args[key] + "-original";
      await rename(args[key], original);
      await symlink(original, args[key]);
      await assert.rejects(captureRunIdentity(args));
    });
  }
});
