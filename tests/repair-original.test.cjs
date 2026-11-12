"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { openArchive } = require("../lib/archive.cjs");
const { readCodex, sourceIdentity } = require("../lib/adapters");
const { repairOriginal } = require("../lib/repair-original.cjs");

test("targeted recapture appends an observation without changing old checkpoint or version", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repair-original-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "archive"),
    file = path.join(root, "session.jsonl");
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-01-01T00:00:00Z",
      payload: { type: "message", role: "user", content: "hello" },
    }) + "\n",
  );
  const scope = { owner: "o", project: "p" },
    input = { source: "codex", file, instance: "i", session: "s" },
    archive = await openArchive({ dir });
  for await (const batch of readCodex({
    ...scope,
    ...input,
    captureOriginal: async ({ coordinate }) => ({
      availability: "source-only",
      reason: "record-size-limit",
      coordinate,
    }),
  }))
    await archive.importBatch(batch);
  const [old] = await archive.listItems(scope),
    key = {
      ...scope,
      ...sourceIdentity({ harness: "codex", instance: "i", session: "s" }),
    };
  const checkpoint = await archive.getCheckpoint(key);
  const result = await repairOriginal(
    { scope, archive },
    [input],
    old.item.id,
    old.versionId,
  );
  assert.equal(result.status, "captured-current-observation");
  assert.deepEqual(await archive.getCheckpoint(key), checkpoint);
  assert.deepEqual(
    await archive.getItem({
      ...scope,
      id: old.item.id,
      revision: old.versionId,
    }),
    old,
  );
  assert.equal((await archive.listItems(scope)).length, 2);
  assert.equal(
    (
      await repairOriginal(
        { scope, archive },
        [input],
        old.item.id,
        old.versionId,
      )
    ).itemsImported,
    0,
  );
  const blobsBeforeMismatch = await fs.readdir(path.join(dir, "originals"));
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-01-01T00:00:00Z",
      payload: { type: "message", role: "user", content: "changed" },
    }) + "\n",
  );
  await assert.rejects(
    repairOriginal({ scope, archive }, [input], old.item.id, old.versionId),
    /changed/,
  );
  assert.deepEqual(
    await fs.readdir(path.join(dir, "originals")),
    blobsBeforeMismatch,
  );
  await assert.rejects(
    repairOriginal(
      { scope, archive },
      [{ ...input, instance: "other" }],
      old.item.id,
      old.versionId,
    ),
    /unavailable or ambiguous/,
  );
});
