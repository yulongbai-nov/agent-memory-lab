"use strict";
// Separate full eight-slot alias experiment; default is a zero-model preflight.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  { createHash } = require("node:crypto");
const {
  constructAliases,
  decodeSampleAnswer,
  run: preflightRun,
} = require("./paired-alias-preflight.cjs");
const { preflight, score, live } = require("./paired-reader.cjs");
const { decodeContext } = require("./reference-alias.cjs");
const hash = (x) => createHash("sha256").update(x).digest("hex");
const BASELINE_SHA =
  "b3cbb9ae427e338b3988d5ea619ba6c3069934a4cb861a5c8093b112314d6608";
function compareBaseline(samples, wire, baselineCases) {
  if (
    samples.length !== 8 ||
    wire.length !== 8 ||
    !Array.isArray(baselineCases) ||
    baselineCases.length !== 8
  )
    throw Error("baseline length mismatch");
  for (const [i, sample] of samples.entries()) {
    const baseline = baselineCases[i];
    if (
      baseline.id !== sample.id ||
      baseline.arm !== sample.arm ||
      hash(baseline.wireBody) !== baseline.wireSha256
    )
      throw Error("baseline identity or hash mismatch");
    const encoded = JSON.parse(wire[i].body),
      old = JSON.parse(baseline.wireBody),
      input = JSON.parse(encoded.input),
      oldInput = JSON.parse(old.input);
    input.evidence = decodeContext(
      input.evidence,
      sample.context,
      { id: sample.id, arm: sample.arm, scope: sample.scope },
      sample.mapping,
    );
    if (JSON.stringify(input) !== JSON.stringify(oldInput))
      throw Error("baseline question or evidence mismatch");
    encoded.input = JSON.stringify(input);
    if (JSON.stringify(encoded) !== JSON.stringify(old))
      throw Error("baseline request differs beyond reference serialization");
  }
  return true;
}
async function freezeAgainstBaseline(baselineFile, output) {
  const bytes = await fs.readFile(baselineFile);
  if (hash(bytes) !== BASELINE_SHA)
    throw Error("unexpected original result file");
  const baseline = JSON.parse(bytes),
    check = await preflightRun(),
    samples = await constructAliases(),
    wire = await preflight(samples);
  if (
    samples.length !== 8 ||
    wire.some(
      (w, i) =>
        w.sha256 !== check.cases[i]?.wireSha256 ||
        w.body !== check.cases[i]?.wireBody ||
        JSON.stringify(samples[i].mapping) !==
          JSON.stringify(check.cases[i]?.mapping),
    )
  )
    throw Error("independent alias freeze mismatch");
  compareBaseline(samples, wire, baseline.frozen);
  const result = {
    ...check,
    baseline: {
      resultSha256: BASELINE_SHA,
      cases: baseline.frozen.map(({ id, arm, wireSha256, wireBody }) => ({
        id,
        arm,
        wireSha256,
        wireBody,
      })),
      onlyReferenceSerializationDiffers: true,
    },
  };
  await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return result;
}
function assessAlias(sample, answer) {
  if (!answer || typeof answer !== "object" || !Array.isArray(answer.facts))
    return {
      decodedAnswer: null,
      decodeErrors: "invalid-answer",
      assessment: score(sample, answer, require("./paired-oracle.cjs")),
    };
  let errors = 0;
  const decodedAnswer = structuredClone(answer);
  for (const [i, fact] of decodedAnswer.facts.entries()) {
    if (!fact || !Array.isArray(fact.citations)) continue;
    fact.citations = fact.citations.map((alias, j) => {
      try {
        return decodeSampleAnswer(sample, {
          facts: [{ value: "synthetic", citations: [alias] }],
        }).facts[0].citations[0];
      } catch {
        errors++;
        return `unresolved-alias:${i}:${j}`;
      }
    });
  }
  return {
    decodedAnswer,
    decodeErrors: errors,
    assessment: score(sample, decodedAnswer, require("./paired-oracle.cjs")),
  };
}
async function prepare(frozenFile) {
  const prior = JSON.parse(await fs.readFile(frozenFile, "utf8"));
  const check = await preflightRun();
  if (
    prior.mode !== "synthetic-alias-preflight" ||
    prior.sentToRealProvider !== 0 ||
    prior.oracleRulesChanged !== 8 ||
    prior.oracleWireUnchanged !== true ||
    prior.leakChangedWireCount !== 8 ||
    JSON.stringify(prior.cases) !== JSON.stringify(check.cases)
  )
    throw Error("alias freeze mismatch");
  const samples = await constructAliases(),
    wire = await preflight(samples);
  if (
    samples.length !== 8 ||
    wire.some(
      (w, i) =>
        w.sha256 !== prior.cases[i].wireSha256 ||
        w.body !== prior.cases[i].wireBody,
    )
  )
    throw Error("alias wire freeze mismatch");
  if (
    prior.baseline?.resultSha256 !== BASELINE_SHA ||
    prior.baseline?.onlyReferenceSerializationDiffers !== true
  )
    throw Error("baseline evidence missing");
  compareBaseline(samples, wire, prior.baseline.cases);
  return {
    samples,
    freeze: prior.cases,
    freezeSha256: hash(JSON.stringify(prior.cases)),
  };
}
async function reserveLock(freezeSha256, base = os.tmpdir()) {
  if (!/^[a-f0-9]{64}$/.test(freezeSha256)) throw Error("invalid freeze hash");
  const lock = path.join(base, `agent-memory-alias-${freezeSha256}.once.lock`);
  const h = await fs.open(lock, "wx", 0o600);
  try {
    await h.writeFile(
      JSON.stringify({ mode: "synthetic-alias-paired", freezeSha256 }) + "\n",
    );
    await h.sync();
  } finally {
    await h.close();
  }
  return lock;
}
async function runLive(frozenFile, resultFile, options = {}) {
  if (!frozenFile || !resultFile || frozenFile === resultFile)
    throw Error("separate freeze and result files required");
  if (!(options.enabled ?? process.env.MEMLAB_PAIRED_REAL === "1"))
    throw Error("explicit live enablement required");
  const prepared = await prepare(frozenFile);
  await reserveLock(prepared.freezeSha256);
  return live(prepared.samples, prepared.freeze, resultFile, {
    ...options,
    requireWireHashes: true,
    assess: assessAlias,
  });
}
if (require.main === module) {
  const [mode = "--preflight", frozen, result] = process.argv.slice(2);
  if (mode === "--preflight" && frozen && result && process.argv.length === 5)
    freezeAgainstBaseline(frozen, result)
      .then((x) =>
        console.log(
          JSON.stringify({
            mode: x.mode,
            cases: x.cases.length,
            sentToRealProvider: 0,
            baseline: x.baseline.resultSha256,
          }),
        ),
      )
      .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      });
  else if (mode === "--live" && frozen && result && process.argv.length === 5)
    runLive(frozen, result)
      .then((x) =>
        console.log(
          JSON.stringify({
            status: x.runStatus,
            results: x.results.length,
            artifact: result,
          }),
        ),
      )
      .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      });
  else {
    console.error(
      "Use --preflight original-synthetic-result freeze-file or --live freeze-file result-file; live requires explicit enablement and a fresh local proxy.",
    );
    process.exitCode = 2;
  }
}
module.exports = {
  assessAlias,
  prepare,
  runLive,
  reserveLock,
  compareBaseline,
  freezeAgainstBaseline,
};
