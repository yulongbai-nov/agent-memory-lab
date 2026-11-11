"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
test("trusted proxy stage contains every dependency and loads without credentials", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "proxy-stage-"));
  try {
    const stage = join(dir, "image");
    execFileSync(
      "sh",
      [
        join(__dirname, "../benchmark/harness-e2e/stage-proxy.sh"),
        stage,
        "node:24.12.0-bookworm-slim",
      ],
      { env: { PATH: process.env.PATH } },
    );
    assert.deepEqual((await fs.readdir(stage)).sort(), [
      "Dockerfile",
      "openai-proxy.cjs",
      "response-metadata.cjs",
    ]);
    assert.match(
      await fs.readFile(join(stage, "Dockerfile"), "utf8"),
      /^FROM node:24\.12\.0-bookworm-slim\nCOPY openai-proxy\.cjs response-metadata\.cjs \/opt\/\nUSER node\n$/,
    );
    const result = execFileSync(
      process.execPath,
      [
        "-e",
        'const x=require(process.argv[1]); if(typeof x.createBudgetProxy!=="function")process.exit(1);',
        join(stage, "openai-proxy.cjs"),
      ],
      { env: { PATH: process.env.PATH }, encoding: "utf8" },
    );
    assert.equal(result, "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
