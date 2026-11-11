"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const legacyJavaScript = require("./legacy-js-scope.json");

const typescript = [
  "src/bounded-memory-find.cts",
  "src/bounded-memory-read.cts",
  "src/chatgpt-snapshot.cts",
  "src/ontology-projection.cts",
  "src/local-draft-state.cts",
  "src/local-admission.cts",
  "src/collector.cts",
  "src/semantic-queue.cts",
  "src/semantic-validation.cts",
  "src/find-preview.cts",
];
const lintedJavaScript = [
  "benchmark/harness-e2e/codex/find-contract.cjs",
  "benchmark/harness-e2e/codex/read-contract.cjs",
  "benchmark/harness-e2e/dsh/bounded-contract.cjs",
  "benchmark/memory-views/run.cjs",
  "benchmark/memory-views/evidence-bundle.cjs",
  "benchmark/memory-views/paired-fixtures.cjs",
  "benchmark/memory-views/paired-oracle-worker.cjs",
  "benchmark/memory-views/paired-oracle.cjs",
  "benchmark/memory-views/paired-reader.cjs",
  "benchmark/memory-views/paired-score.cjs",
  "benchmark/harness-e2e/response-metadata.cjs",
  "tests/paired-reader.test.cjs",
  "tests/proxy-staging.test.cjs",
  "lib/find-preview.cjs",
  "tests/find-preview.test.cjs",
  "tests/memory-evidence-bundle-holdout.test.cjs",
  "eslint.config.mjs",
  "lib/adapters/chatgpt-snapshot.cjs",
  "lib/bounded-memory-relay.cjs",
  "lib/local-draft-index.cjs",
  "lib/nocache-hash.cjs",
  "lib/local-run-integrity.cjs",
  "lib/collector.cjs",
  "tests/collector.test.cjs",
  "lib/codex-discovery.cjs",
  "lib/ontology-projection.cjs",
  "scripts/check-ts-scope.cjs",
  "scripts/smoke-package.cjs",
  "tests/bounded-memory-dsh.test.cjs",
  "tests/bounded-memory-find.test.cjs",
  "tests/chatgpt-snapshot.test.cjs",
  "tests/codex-discovery.test.cjs",
  "tests/ontology-projection.test.cjs",
  "tests/local-draft-state.test.cjs",
  "tests/local-admission.test.cjs",
  "tests/nocache-hash.test.cjs",
  "tests/local-run-integrity.test.cjs",
  "tests/local-derive-recovery.test.cjs",
];
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
).split("\0");
const present = [...new Set(files)].filter((file) => {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) return false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Unexpected source path: ${file}`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
});
const actualTypescript = present.filter((file) =>
  /\.(?:[cm]?ts|tsx)$/.test(file),
);
const actualJavaScript = present.filter((file) =>
  /\.(?:[cm]?js|jsx)$/.test(file),
);

function check(actual, expected, label) {
  const added = actual.filter((file) => !expected.includes(file));
  const removed = expected.filter((file) => !actual.includes(file));
  if (added.length || removed.length) {
    throw new Error(
      `${label} scope changed. Review the explicit gates. Added: ${added.join(", ")}. Removed: ${removed.join(", ")}.`,
    );
  }
}
check(actualTypescript, typescript, "TypeScript");
check(
  actualJavaScript,
  [...legacyJavaScript, ...lintedJavaScript],
  "JavaScript",
);
