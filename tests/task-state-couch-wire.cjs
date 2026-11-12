"use strict";

// File-backed test transport for the CLI's Couch wire calls. No network.
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const assert = require("node:assert/strict");
const folder = process.env.TASK_STATE_WIRE_STORE;

globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  assert.equal(url.origin, "http://127.0.0.1:5984");
  assert.ok(url.pathname.startsWith("/task-state-test/"));
  assert.ok(folder);
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const suffix = decodeURIComponent(url.pathname.split("/").at(-1));
  if (suffix === "_all_docs") {
    const first = JSON.parse(url.searchParams.get("startkey"));
    const last = JSON.parse(url.searchParams.get("endkey"));
    const skip = Number(url.searchParams.get("skip") || 0);
    const limit = Number(url.searchParams.get("limit"));
    const files = (await fs.readdir(folder)).sort().filter((name) => {
      const id = `immutable:${name}`;
      return id >= first && id <= last;
    });
    const rows = await Promise.all(
      files.slice(skip, skip + limit).map(async (name) => {
        const doc = JSON.parse(await fs.readFile(path.join(folder, name)));
        return { id: doc._id, doc };
      }),
    );
    return json({ rows });
  }
  const digest = /^immutable:([a-f0-9]{64})$/.exec(suffix)?.[1];
  assert.ok(digest);
  const file = path.join(folder, digest);
  if (options.method === "PUT") {
    const doc = JSON.parse(options.body);
    assert.equal(doc._id, suffix);
    try {
      await fs.writeFile(file, options.body, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") return json({ error: "conflict" }, 409);
      throw error;
    }
    return json({ ok: true }, 201);
  }
  return json(JSON.parse(await fs.readFile(file)));
};
