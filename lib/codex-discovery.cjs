"use strict";
// Explicit opt-in union of Codex's active and archived rollout roots. Existing
// discovery remains unchanged; only validated conventional rollouts are mapped.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { discover } = require("./discover.cjs");
const { sourceIdentity } = require("./adapters");
const HEADER_LIMIT = 256 * 1024,
  COMPARE_LIMIT = 128 * 1024 * 1024;
function filenameIdentity(name) {
  const m =
    /^rollout-(\d{4})-(\d{2})-(\d{2})T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
      name,
    );
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`
  )
    return null;
  return {
    session: [m[1], m[2], m[3], name].join("/"),
    id: m[4].toLowerCase(),
  };
}
async function validHeader(file, id) {
  let handle;
  try {
    handle = await fsp.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    if (!before.isFile()) return false;
    const b = Buffer.alloc(Math.min(HEADER_LIMIT, before.size));
    const { bytesRead } = await handle.read(b, 0, b.length, 0);
    const end = b.subarray(0, bytesRead).indexOf(10);
    if (end < 0) return false;
    const header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, end)),
    );
    const after = await handle.stat();
    const verify = Buffer.alloc(end + 1);
    const repeat = await handle.read(verify, 0, verify.length, 0);
    return (
      repeat.bytesRead === verify.length &&
      verify.equals(b.subarray(0, end + 1)) &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      after.size >= before.size &&
      header?.type === "session_meta" &&
      typeof header.payload?.id === "string" &&
      header.payload.id.toLowerCase() === id
    );
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
async function digestStable(file) {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.size > COMPARE_LIMIT)
    throw Error("unverifiable overlap");
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  const after = await fsp.lstat(file);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  )
    throw Error("source changed");
  return h.digest("hex");
}
async function discoverCodexCombined({
  activeRoot,
  archiveRoot,
  maximum = 25,
  offset = 0,
  recent = false,
}) {
  if (!activeRoot || !archiveRoot)
    throw new TypeError("Explicit active and archive roots are required");
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 20000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new TypeError("Invalid scan limits");
  const [activePath, archivePath] = await Promise.all([
    fsp.realpath(activeRoot),
    fsp.realpath(archiveRoot),
  ]);
  if (activePath === archivePath)
    throw new Error("Active and archived Codex roots must differ");
  const [active, archived] = await Promise.all([
    discover(activePath, "codex", { maximum: 20000 }),
    discover(archivePath, "codex", { maximum: 20000 }),
  ]);
  const groups = new Map(),
    idPaths = new Map(),
    legacyActive = [];
  let unverifiable = 0,
    ambiguous = 0,
    duplicates = 0;
  for (const [source, rows] of [
    ["active", active.files],
    ["archive", archived.files],
  ])
    for (const row of rows) {
      const identity = filenameIdentity(path.basename(row.file));
      if (
        !identity ||
        (source === "active" &&
          row.session.split(path.sep).join("/") !== identity.session)
      ) {
        if (source === "active")
          legacyActive.push({
            file: row.file,
            session: row.session,
            legacySession: null,
            source,
          });
        else unverifiable++;
        continue;
      }
      if (
        (source === "archive" && row.session !== path.basename(row.file)) ||
        !(await validHeader(row.file, identity.id))
      ) {
        unverifiable++;
        continue;
      }
      const entry = {
        file: row.file,
        session: identity.session,
        legacySession: source === "archive" ? path.basename(row.file) : null,
        source,
      };
      const paths = idPaths.get(identity.id) || new Set();
      paths.add(identity.session);
      idPaths.set(identity.id, paths);
      const group = groups.get(identity.session) || [];
      group.push(entry);
      groups.set(identity.session, group);
    }
  const chosen = [...legacyActive],
    legacyNames = new Set(legacyActive.map((x) => path.basename(x.file)));
  for (const group of groups.values()) {
    const identity = filenameIdentity(path.basename(group[0].file));
    if (legacyNames.has(path.basename(group[0].file))) {
      ambiguous++;
      continue;
    }
    if (idPaths.get(identity.id).size > 1) {
      ambiguous++;
      continue;
    }
    if (group.length > 1) {
      try {
        const hashes = await Promise.all(
          group.map((x) => digestStable(x.file)),
        );
        if (new Set(hashes).size !== 1) {
          ambiguous++;
          continue;
        }
        duplicates += group.length - 1;
      } catch {
        ambiguous++;
        continue;
      }
    }
    const selected = group.find((x) => x.source === "active") || group[0];
    // Check the historical archived-root key even when only an active copy remains.
    selected.legacySession = path.basename(selected.file);
    chosen.push(selected);
  }
  if (recent) {
    const times = new Map();
    for (const entry of chosen) {
      try {
        times.set(entry.file, (await fsp.lstat(entry.file)).mtimeMs);
      } catch {
        times.set(entry.file, 0);
      }
    }
    chosen.sort(
      (a, b) =>
        (times.get(b.file) || 0) - (times.get(a.file) || 0) ||
        a.session.localeCompare(b.session),
    );
  } else chosen.sort((a, b) => a.session.localeCompare(b.session));
  return {
    files: chosen.slice(offset, offset + maximum),
    discovered: chosen.length,
    duplicates,
    ambiguous,
    unverifiable,
    inaccessible: active.inaccessible + archived.inaccessible,
    traversalLimited:
      active.traversalLimited ||
      archived.traversalLimited ||
      active.nextOffset !== null ||
      archived.nextOffset !== null,
    nextOffset: chosen.length > offset + maximum ? offset + maximum : null,
  };
}
// lookup(session) must check the same owner/project/instance scope as ingestion.
// Never guess when both historical keys already exist.
async function resolveCodexSession(entry, lookup) {
  if (
    !entry ||
    typeof entry.session !== "string" ||
    typeof lookup !== "function"
  )
    throw new TypeError("Invalid session resolution");
  const aliases = [
    ...new Set([entry.session, entry.legacySession].filter(Boolean)),
  ];
  const found = [];
  for (const session of aliases) if (await lookup(session)) found.push(session);
  if (found.length > 1)
    throw Object.assign(new Error("Ambiguous existing session identity"), {
      code: "CODEX_IDENTITY_AMBIGUOUS",
    });
  return found[0] || entry.session;
}
async function discoverIntakeSources(op, input, root) {
  const limits = { maximum: 20000, recent: true };
  if (input.archiveRoot === undefined)
    return {
      ...(await discover(root, input.source, limits)),
      blocked: 0,
      unverifiable: 0,
    };
  if (
    input.source !== "codex" ||
    typeof input.archiveRoot !== "string" ||
    !input.archiveRoot
  )
    throw new Error("Archive root requires Codex source");
  const snapshot = await discoverCodexCombined({
    activeRoot: root,
    archiveRoot: input.archiveRoot,
    ...limits,
  });
  const files = [];
  let blocked = snapshot.ambiguous;
  for (const entry of snapshot.files) {
    try {
      const session = await resolveCodexSession(entry, (s) =>
        op.archive.getCheckpoint({
          ...op.scope,
          ...sourceIdentity({
            harness: "codex",
            instance: input.instance,
            session: s,
          }),
        }),
      );
      files.push({ ...entry, session });
    } catch (error) {
      if (error.code !== "CODEX_IDENTITY_AMBIGUOUS") throw error;
      blocked++;
    }
  }
  return { ...snapshot, files, blocked };
}
module.exports = {
  discoverCodexCombined,
  resolveCodexSession,
  discoverIntakeSources,
};
