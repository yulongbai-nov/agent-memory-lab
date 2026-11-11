"use strict";
// Rebuildable private index: source references only, never message text.
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = (value) => JSON.parse(value);
function openDraftIndex(file, initialState) {
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077)
    throw Error("Invalid local draft index");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, source TEXT NOT NULL, turn_id TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages (version TEXT PRIMARY KEY, turn_key TEXT NOT NULL, item_id TEXT NOT NULL, role TEXT NOT NULL, seq INTEGER NOT NULL, seen_gen INTEGER NOT NULL DEFAULT 0, work_gen INTEGER NOT NULL DEFAULT 0, context_seq INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, reason TEXT);
    CREATE INDEX IF NOT EXISTS message_turn_role_seq ON messages(turn_key,role,seq);
    CREATE INDEX IF NOT EXISTS message_role_seq ON messages(role,seq);
    CREATE INDEX IF NOT EXISTS message_retry_at ON messages(retry_at);
    CREATE INDEX IF NOT EXISTS message_role_retry_seq ON messages(role,retry_at,seq);
    CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY,user_version TEXT NOT NULL, generation INTEGER NOT NULL, context_seq INTEGER NOT NULL, finish INTEGER NOT NULL, members TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_members (job_key TEXT NOT NULL, user_version TEXT NOT NULL, PRIMARY KEY(job_key,user_version));
    CREATE INDEX IF NOT EXISTS job_members_user ON job_members(user_version);
    CREATE TABLE IF NOT EXISTS held_context (user_version TEXT NOT NULL,context_version TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(user_version,context_version));
    CREATE TABLE IF NOT EXISTS context_skips (user_version TEXT NOT NULL, context_version TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(user_version,context_version));
    CREATE TABLE IF NOT EXISTS deferred_context (version TEXT PRIMARY KEY, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS held_jobs (key TEXT PRIMARY KEY, job TEXT NOT NULL, reason TEXT NOT NULL, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS completed (key TEXT PRIMARY KEY);
  `);
  const get = db.prepare("SELECT value FROM meta WHERE key=?"),
    put = db.prepare(
      "INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );
  const read = (k) => {
    const r = get.get(k);
    return r ? parse(r.value) : null;
  };
  const write = (k, v) => put.run(k, JSON.stringify(v));
  if (!read("progress"))
    write("progress", { cursor: 0, fence: 0, anchor: null });
  if (!read("queue")) write("queue", initialState);
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const turnKey = (source, turn) =>
    hash([source.harness, source.instance, source.session, turn]);
  let buffered = [];
  function markDirty(turn) {
    const row = db
      .prepare(
        "SELECT seq FROM messages WHERE turn_key=? AND role='user' ORDER BY seq LIMIT 1",
      )
      .get(turn);
    if (row) {
      const old = read("dirtyMin");
      write("dirtyMin", old === null ? row.seq : Math.min(old, row.seq));
    }
  }
  function ingest(rows, newProgress) {
    return tx(() => {
      const changedTurns = new Set();
      for (const { seq, record } of rows) {
        if (!record?.source || !record.item) continue;
        const { item } = record,
          source = {
            harness: record.source.harness,
            instance: record.source.instance,
            session: record.source.session,
          };
        if (!["dsh", "codex"].includes(source.harness) || !item.turnId)
          continue;
        const key = turnKey(source, item.turnId),
          type = item.metadata?.recordType || "";
        const terminal =
          type === "turn/end" ||
          type.startsWith("turn/end:") ||
          [
            "event_msg:task_complete",
            "event_msg:turn_completed",
            "turn/completed",
          ].includes(type);
        const message =
          item.kind === "message" &&
          ["user", "assistant"].includes(item.role) &&
          (type === "response_item:message" ||
            type === "user/message" ||
            type === "assistant/message" ||
            type.startsWith("user/message:") ||
            type.startsWith("assistant/message:")) &&
          (item.status == null || item.status === "completed");
        if (!terminal && !message) continue;
        changedTurns.add(key);
        db.prepare(
          "INSERT OR IGNORE INTO turns(id,source,turn_id) VALUES (?,?,?)",
        ).run(key, JSON.stringify(source), item.turnId);
        if (message) {
          const r = db
            .prepare(
              "INSERT OR IGNORE INTO messages(version,turn_key,item_id,role,seq) VALUES (?,?,?,?,?)",
            )
            .run(record.versionId, key, item.id, item.role, seq);
          if (r.changes)
            db.prepare(
              item.role === "user"
                ? "UPDATE turns SET generation=MAX(generation,1) WHERE id=?"
                : "UPDATE turns SET generation=generation+1 WHERE id=?",
            ).run(key);
        }
        if (
          terminal &&
          ["completed", "failed", "interrupted"].includes(item.status)
        )
          db.prepare(
            "UPDATE turns SET complete=MAX(complete,?), invalid=MAX(invalid,?), generation=generation+1 WHERE id=?",
          ).run(
            Number(item.status === "completed"),
            Number(item.status !== "completed"),
            key,
          );
      }
      for (const key of changedTurns) markDirty(key);
      buffered = [];
      write("progress", newProgress);
    });
  }
  function candidate(now, budget) {
    let p = read("candidateProgress") || { cursor: 0, fence: 0 },
      examined = 0;
    if (p.cursor >= p.fence) {
      const max = db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE role='user'",
        )
        .get().seq;
      const due = db
        .prepare(
          "SELECT seq FROM messages WHERE role='user' AND retry_at>0 AND retry_at<=? ORDER BY retry_at,seq LIMIT 1",
        )
        .get(now);
      const dirty = read("dirtyMin"),
        rewind = [dirty, due?.seq].filter(
          (x) => Number.isSafeInteger(x) && x <= p.cursor,
        );
      if (rewind.length) p.cursor = Math.min(...rewind) - 1;
      p.fence = max;
      tx(() => {
        write("dirtyMin", null);
        write("candidateProgress", p);
      });
      buffered = [];
      if (p.cursor >= p.fence)
        return { candidate: null, examined: 0, continuation: false };
    }
    buffered = buffered.filter((x) => x.seq > p.cursor && x.seq <= p.fence);
    if (!buffered.length) {
      if (budget <= 0)
        return { candidate: null, examined: 0, continuation: true };
      buffered = db
        .prepare(
          "SELECT seq,version FROM messages WHERE role='user' AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
        )
        .all(p.cursor, p.fence, budget);
      examined = buffered.length;
      if (!buffered.length) {
        p.cursor = p.fence;
        write("candidateProgress", p);
        return { candidate: null, examined, continuation: true };
      }
    }
    let r;
    for (const entry of buffered) {
      const row = db
        .prepare(
          `SELECT m.*,t.source,t.generation,t.complete,t.invalid,EXISTS(SELECT 1 FROM job_members j WHERE j.user_version=m.version) AS queued
        FROM messages m JOIN turns t ON t.id=m.turn_key WHERE m.version=?`,
        )
        .get(entry.version);
      if (
        row &&
        row.complete === 1 &&
        row.invalid === 0 &&
        row.seen_gen < row.generation &&
        row.retry_at <= now &&
        !row.queued
      ) {
        r = row;
        break;
      }
      p.cursor = entry.seq;
    }
    write("candidateProgress", p);
    if (!r) return { candidate: null, examined, continuation: true };
    const cursor = r.work_gen === r.generation ? r.context_seq : 0;
    const hasAssistant = Boolean(
      db
        .prepare(
          "SELECT 1 FROM messages WHERE turn_key=? AND role='assistant' LIMIT 1",
        )
        .get(r.turn_key),
    );
    const peerRows = hasAssistant
      ? []
      : db
          .prepare(
            `WITH page AS MATERIALIZED (SELECT * FROM messages WHERE turn_key=? AND role='user' AND seq>? ORDER BY seq LIMIT 3)
      SELECT page.*,EXISTS(SELECT 1 FROM job_members j WHERE j.user_version=page.version) AS queued FROM page ORDER BY seq`,
          )
          .all(r.turn_key, r.seq);
    const peers = peerRows.filter(
      (x) => x.seen_gen < r.generation && x.retry_at <= now && !x.queued,
    );
    const rawAssistants = db
      .prepare(
        `WITH page AS MATERIALIZED (SELECT * FROM messages WHERE turn_key=? AND role='assistant' AND seq>? ORDER BY seq LIMIT 2)
      SELECT page.*,d.retry_at AS deferred_until,EXISTS(SELECT 1 FROM held_context h WHERE h.context_version=page.version AND h.user_version=?) AS held
      FROM page LEFT JOIN deferred_context d ON d.version=page.version ORDER BY page.seq`,
      )
      .all(r.turn_key, cursor, r.version);
    const first = rawAssistants[0];
    const page =
      peers.length ||
      !first ||
      first.held ||
      (first.deferred_until !== null && first.deferred_until > now)
        ? []
        : [first];
    return {
      candidate: {
        user: r,
        source: parse(r.source),
        peers,
        assistants: page,
        finish: rawAssistants.length <= 1,
        contextSeq: peers.length ? cursor : first ? first.seq : cursor,
      },
      examined,
      continuation: true,
    };
  }
  function advanceCursor(c) {
    const p = read("candidateProgress");
    if (!p || c.user.seq <= p.cursor || c.user.seq > p.fence)
      throw Error("Invalid candidate cursor");
    p.cursor = c.user.seq;
    write("candidateProgress", p);
  }
  function advance(c, reason) {
    return tx(() => {
      db.prepare(
        "UPDATE messages SET seen_gen=?,work_gen=?,context_seq=?,retry_at=0,attempts=0,reason=? WHERE version=?",
      ).run(
        c.finish ? c.user.generation : c.user.seen_gen,
        c.user.generation,
        c.contextSeq,
        reason || null,
        c.user.version,
      );
      advanceCursor(c);
      if (!c.finish) markDirty(c.user.turn_key);
    });
  }
  function defer(c, now, reason, { advance = true } = {}) {
    const attempts = c.user.attempts + 1,
      delay =
        attempts === 1
          ? 0
          : Math.min(300000, 1000 * 2 ** Math.min(9, attempts - 2));
    return tx(() => {
      db.prepare(
        "UPDATE messages SET attempts=?,retry_at=?,reason=? WHERE version=?",
      ).run(attempts, now + delay, reason, c.user.version);
      if (advance) advanceCursor(c);
    });
  }
  function holdContext(userVersion, contextVersion) {
    db.prepare(
      "INSERT OR REPLACE INTO held_context(user_version,context_version,reason) VALUES (?,?,'CONTEXT_BUDGET')",
    ).run(userVersion, contextVersion);
  }
  function skipContext(userVersion, contextVersion) {
    db.prepare(
      "INSERT OR REPLACE INTO context_skips(user_version,context_version,reason) VALUES (?,?,'projection-or-batch-budget')",
    ).run(userVersion, contextVersion);
  }
  function deferContext(member, now) {
    const old = db
      .prepare("SELECT attempts FROM deferred_context WHERE version=?")
      .get(member.version);
    const attempts = (old?.attempts || 0) + 1,
      delay =
        attempts === 1
          ? 0
          : Math.min(300000, 1000 * 2 ** Math.min(9, attempts - 2));
    db.prepare(
      "INSERT INTO deferred_context(version,attempts,retry_at,reason) VALUES (?,?,?,'ORIGINAL_UNAVAILABLE') ON CONFLICT(version) DO UPDATE SET attempts=excluded.attempts,retry_at=excluded.retry_at",
    ).run(member.version, attempts, now + delay);
  }
  function dueContext(now) {
    const r = db
      .prepare(
        "SELECT m.*,t.source FROM deferred_context d JOIN messages m ON m.version=d.version JOIN turns t ON t.id=m.turn_key WHERE d.retry_at<=? ORDER BY d.retry_at,m.seq LIMIT 1",
      )
      .get(now);
    return r ? { ...r, source: parse(r.source) } : null;
  }
  function restoreContext(member) {
    return tx(() => {
      db.prepare("DELETE FROM deferred_context WHERE version=?").run(
        member.version,
      );
      db.prepare("UPDATE turns SET generation=generation+1 WHERE id=?").run(
        member.turn_key,
      );
      markDirty(member.turn_key);
    });
  }
  function stage(key, c, queue, members) {
    return tx(() => {
      db.prepare(
        "INSERT INTO jobs(key,user_version,generation,context_seq,finish,members) VALUES (?,?,?,?,?,?)",
      ).run(
        key,
        c.user.version,
        c.user.generation,
        c.contextSeq,
        Number(c.finish),
        JSON.stringify(members),
      );
      for (const version of members)
        db.prepare(
          "INSERT INTO job_members(job_key,user_version) VALUES (?,?)",
        ).run(key, version);
      write("queue", queue);
      advanceCursor(c);
    });
  }
  function jobValid(key) {
    const row = db
      .prepare(
        "SELECT t.complete,t.invalid FROM jobs j JOIN messages m ON m.version=j.user_version JOIN turns t ON t.id=m.turn_key WHERE j.key=?",
      )
      .get(key);
    return Boolean(row && row.complete === 1 && row.invalid === 0);
  }
  function holdJob(job, queue) {
    return tx(() => {
      const meta = db.prepare("SELECT * FROM jobs WHERE key=?").get(job.key);
      if (!meta) throw Error("Missing local draft job");
      db.prepare(
        "INSERT INTO held_jobs(key,job,reason,metadata) VALUES (?,?,'TURN_INVALIDATED',?)",
      ).run(job.key, JSON.stringify(job), JSON.stringify(meta));
      db.prepare(
        "UPDATE messages SET retry_at=0,attempts=0,reason='TURN_INVALIDATED' WHERE version=?",
      ).run(meta.user_version);
      db.prepare("DELETE FROM job_members WHERE job_key=?").run(job.key);
      db.prepare("DELETE FROM jobs WHERE key=?").run(job.key);
      write("queue", queue);
    });
  }
  function finish(key, queue) {
    return tx(() => {
      const job = db.prepare("SELECT * FROM jobs WHERE key=?").get(key);
      if (!job) throw Error("Missing local draft job");
      const user = db
        .prepare("SELECT * FROM messages WHERE version=?")
        .get(job.user_version);
      if (!user) throw Error("Missing local draft input");
      db.prepare("INSERT OR IGNORE INTO completed(key) VALUES (?)").run(key);
      db.prepare(
        "UPDATE messages SET seen_gen=?,work_gen=?,context_seq=?,retry_at=0,attempts=0,reason=NULL WHERE version=?",
      ).run(
        job.finish ? job.generation : user.seen_gen,
        job.generation,
        job.context_seq,
        user.version,
      );
      if (!job.finish) markDirty(user.turn_key);
      for (const version of parse(job.members))
        if (version !== user.version)
          db.prepare(
            "UPDATE messages SET seen_gen=?,work_gen=?,context_seq=0,retry_at=0,attempts=0,reason=NULL WHERE version=?",
          ).run(job.generation, job.generation, version);
      db.prepare("DELETE FROM job_members WHERE job_key=?").run(key);
      db.prepare("DELETE FROM jobs WHERE key=?").run(key);
      write("queue", queue);
    });
  }
  return {
    read,
    write,
    tx,
    ingest,
    candidate,
    hasBufferedCandidates: () => {
      const p = read("candidateProgress");
      return Boolean(
        p && buffered.some((x) => x.seq > p.cursor && x.seq <= p.fence),
      );
    },
    candidateContinuation: () => {
      const p = read("candidateProgress");
      return Boolean((p && p.cursor < p.fence) || read("dirtyMin"));
    },
    advance,
    defer,
    deferContext,
    skipContext,
    holdContext,
    hasHeldContext: () =>
      Boolean(db.prepare("SELECT 1 FROM held_context LIMIT 1").get()),
    hasInvalidated: () =>
      Boolean(db.prepare("SELECT 1 FROM held_jobs LIMIT 1").get()),
    dueContext,
    restoreContext,
    stage,
    finish,
    jobValid,
    holdJob,
    hasDeferred: () =>
      Boolean(db.prepare("SELECT 1 FROM held_context LIMIT 1").get()) ||
      Boolean(db.prepare("SELECT 1 FROM held_jobs LIMIT 1").get()) ||
      Boolean(db.prepare("SELECT 1 FROM deferred_context LIMIT 1").get()) ||
      Boolean(
        db.prepare("SELECT 1 FROM messages WHERE retry_at>0 LIMIT 1").get(),
      ),
    done: (key) =>
      Boolean(db.prepare("SELECT 1 FROM completed WHERE key=?").get(key)),
    close: () => db.close(),
  };
}
module.exports = { openDraftIndex };
