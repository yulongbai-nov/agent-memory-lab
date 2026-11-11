"use strict";
// Separate synthetic-only version: the existing long-reference live path is untouched.
const fs = require("node:fs/promises");
const { fork } = require("node:child_process");
const { join } = require("node:path");
const { construct, preflight } = require("./paired-reader.cjs");
const {
  encodeContext,
  decodeContext,
  decodeAnswer,
} = require("./reference-alias.cjs");
async function constructAliases() {
  const original = await construct();
  return original.map((sample) => {
    const id = { id: sample.id, arm: sample.arm, scope: sample.scope };
    const encoded = encodeContext(sample.context, id);
    const body = JSON.parse(sample.body),
      input = JSON.parse(body.input);
    if (JSON.stringify(input.evidence) !== JSON.stringify(sample.context))
      throw Error("Original request context mismatch");
    input.evidence = encoded.context;
    body.input = JSON.stringify(input);
    if (
      JSON.stringify(
        decodeContext(encoded.context, sample.context, id, encoded.mapping),
      ) !== JSON.stringify(sample.context)
    )
      throw Error("Context round trip failed");
    return {
      ...sample,
      body: JSON.stringify(body),
      displayContext: encoded.context,
      mapping: encoded.mapping,
    };
  });
}
function decodeSampleAnswer(sample, answer) {
  return decodeAnswer(
    answer,
    sample.context,
    { id: sample.id, arm: sample.arm, scope: sample.scope },
    sample.mapping,
  );
}
function worker(variant, leak = false) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      ["PATH", "HOME", "NODE_PATH", "LANG", "TMPDIR"]
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k]]),
    );
    const child = fork(
      join(__dirname, "paired-alias-worker.cjs"),
      [variant, leak ? "leak" : "normal"],
      { env, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    let result,
      done = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Error("alias worker timeout"));
    }, 30000);
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    }
    child.on("message", (value) => {
      result = value;
    });
    child.on("error", () => finish(Error("alias worker failed")));
    child.on("exit", (code) =>
      finish(code === 0 && result?.ok ? null : Error("alias worker failed")),
    );
  });
}
async function run(artifact) {
  const [original, modified] = await Promise.all([
    worker("original"),
    worker("modified"),
  ]);
  if (
    modified.changedRules !== 8 ||
    JSON.stringify(original.assessment) === JSON.stringify(modified.assessment)
  )
    throw Error("Oracle counterfactual failed");
  if (JSON.stringify(original.wire) !== JSON.stringify(modified.wire))
    throw Error("Oracle influenced alias requests");
  const [leakA, leakB] = await Promise.all([
    worker("original", true),
    worker("modified", true),
  ]);
  const leakChanged = leakA.wire.filter(
    (value, i) => value.sha256 !== leakB.wire[i]?.sha256,
  ).length;
  if (leakChanged !== 8) throw Error("Oracle leak negative control failed");
  const samples = await constructAliases(),
    wire = await preflight(samples);
  if (JSON.stringify(wire) !== JSON.stringify(original.wire))
    throw Error("Alias wire differs from freeze");
  const result = {
    schemaVersion: 1,
    mode: "synthetic-alias-preflight",
    model: "gpt-6-luna",
    effort: "low",
    schemaChange: "none",
    selectionBudget: limits(),
    oracleRulesChanged: modified.changedRules,
    oracleWireUnchanged: true,
    leakChangedWireCount: leakChanged,
    sentToRealProvider: 0,
    cases: samples.map((sample, i) => ({
      id: sample.id,
      arm: sample.arm,
      wireSha256: wire[i].sha256,
      wireBody: wire[i].body,
      originalContext: sample.context,
      displayContext: sample.displayContext,
      mapping: sample.mapping,
    })),
  };
  if (artifact)
    await fs.writeFile(artifact, JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  return result;
}
function limits() {
  return { topK: 3, contextBytes: 1900 };
}
if (require.main === module) {
  const [mode = "--preflight", artifact] = process.argv.slice(2);
  if (mode !== "--preflight" || process.argv.length > 4) {
    console.error("Use --preflight [output]");
    process.exitCode = 2;
  } else
    run(artifact)
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
module.exports = { constructAliases, decodeSampleAnswer, run };
