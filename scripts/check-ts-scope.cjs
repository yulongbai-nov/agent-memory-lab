"use strict";
const fs = require("node:fs");
const path = require("node:path");

const expected = ["src/semantic-queue.cts", "src/semantic-validation.cts"];
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(dir, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected symlink in TypeScript scope: ${name}`);
    if (entry.isDirectory()) return walk(name);
    return /\.(?:[cm]?ts|tsx)$/.test(name)
      ? [name.split(path.sep).join("/")]
      : [];
  });
}
const actual = walk("src").sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `TypeScript scope changed; update the explicit gates: ${actual.join(", ")}`,
  );
}
