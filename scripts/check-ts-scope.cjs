"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const legacyJavaScript = require("./legacy-js-scope.json");

const typescript = [
  "src/chatgpt-snapshot.cts",
  "src/ontology-projection.cts",
  "src/semantic-queue.cts",
  "src/semantic-validation.cts",
];
const lintedJavaScript = [
  "benchmark/memory-views/run.cjs",
  "eslint.config.mjs",
  "lib/adapters/chatgpt-snapshot.cjs",
  "lib/codex-discovery.cjs",
  "lib/ontology-projection.cjs",
  "scripts/check-ts-scope.cjs",
  "scripts/smoke-package.cjs",
  "tests/chatgpt-snapshot.test.cjs",
  "tests/codex-discovery.test.cjs",
  "tests/ontology-projection.test.cjs",
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
