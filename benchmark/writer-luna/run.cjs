"use strict";
// Public synthetic regression only. No key loading or default live mode.
const fsp = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  { execFileSync } = require("node:child_process");
const { openArchive } = require("../../lib/archive.cjs");
const { migrateJsonToSqlite } = require("../../lib/storage-sqlite.cjs");
const {
  selectLocalBatch,
  aliasInputs,
} = require("../../lib/local-derive-selection.cjs");
const contract = require("../../lib/candidate-contract-v2.cjs");
const { safeMetadata } = require("../harness-e2e/response-metadata.cjs");
const { buildRequest } = require("../harness-e2e/openai-proxy.cjs");
const { render } = require("./r2-render.cjs");
const sealedFreeze = require("./freeze.json");
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const prompts = [
  "d23136a2298b8f6be207e34e9482b429c1262af319201d19ae9bc6eef7f4a1aa",
  "94f734a4c6a0218b072eab4dfb75feea3d365e7b1f8e6d0b1c06630f6dca709d",
  "bf1d32154115d2668d72643743315a1c63918281f458542e282cee387518e143",
  "52a3ee5c4a7b20af8344f725de4ea3ddfd3bbaf8e6614e1ae2dab4beb921de71",
];
const fixtures = [
  "352da342ed6d3f9b88afc7a6d95cab3ad53e8666fe5511801d542daccb9328b0",
  "835400a150689d1b86aae53a52adfe2ed09b4f0a6803b523e1bf27bf20c7f87f",
  "6fe1a726d6270586391151a6a5e5e151d2ecbab39c14cc8d2a570661c14b8ddd",
  "f13f8398a247901c4fa2e5d58d536db0f43bfe2695a9b04091f468350b4becfd",
];
function adaptSchema(v) {
  if (Array.isArray(v)) return v.map(adaptSchema);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "const") out.enum = [x];
    else if (k === "oneOf") out.anyOf = adaptSchema(x);
    else out[k] = adaptSchema(x);
  }
  return out;
}
const schema = adaptSchema(contract.OUTPUT_SCHEMA_V2);
function request(prompt) {
  return {
    model: "gpt-6-luna",
    reasoning: { effort: "low" },
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "candidate_v2",
        strict: true,
        schema,
      },
    },
    store: false,
    max_output_tokens: 384,
    stream: false,
  };
}
function mapOutput(value, aliases, records) {
  const exact = (rows) =>
    rows.map(({ source, item, version, text }) => ({
      source,
      item,
      version,
      text,
    }));
  const validated = contract.validateVersionedCandidates(value, exact(aliases)),
    byAlias = new Map(
      aliases.map((a, i) => [
        JSON.stringify([a.source, a.item, a.version]),
        records[i],
      ]),
    );
  const mapped = validated.map((c) => ({
    ...c,
    evidence: c.evidence.map((e) => {
      const r = byAlias.get(JSON.stringify([e.source, e.item, e.version]));
      if (!r || !r.projection) throw Error("missing exact source");
      const at = r.text.indexOf(e.quote),
        end = at + e.quote.length;
      if (
        at < 0 ||
        (/[\uD800-\uDBFF]/u.test(r.text[at - 1] || "") &&
          /[\uDC00-\uDFFF]/u.test(r.text[at] || "")) ||
        (/[\uD800-\uDBFF]/u.test(r.text[end - 1] || "") &&
          /[\uDC00-\uDFFF]/u.test(r.text[end] || ""))
      )
        throw Error("invalid span");
      const p = r.projection;
      return {
        source: r.source,
        item: r.item,
        version: r.version,
        quote: e.quote,
        originalSpan: {
          kind: p.kind,
          fieldPath: p.fieldPath,
          originalSha256: p.originalSha256,
          startUtf16: p.startUtf16 + at,
          endUtf16: p.startUtf16 + end,
          startUtf8: p.startUtf8 + Buffer.byteLength(r.text.slice(0, at)),
          endUtf8: p.startUtf8 + Buffer.byteLength(r.text.slice(0, end)),
        },
      };
    }),
  }));
  contract.validateVersionedCandidates(
    {
      protocol: "candidate-v2",
      candidates: mapped.map((c) => ({
        kind: c.kind,
        claim: c.claim,
        ...(c.kind === "decision" ? { basis: c.basis } : {}),
        evidence: c.evidence.map(({ source, item, version, quote }) => ({
          source,
          item,
          version,
          quote,
        })),
      })),
    },
    exact(records),
  );
  return mapped;
}
async function prepare() {
  const tmp = await fsp.mkdtemp(
    path.join(os.tmpdir(), "synthetic-luna-writer-"),
  );
  const slots = [];
  try {
    for (let i = 0; i < 4; i++) {
      const id = `case-0${i + 1}`,
        file = path.join(__dirname, "fixtures", id + ".jsonl"),
        bytes = await fsp.readFile(file);
      if (hash(bytes) !== fixtures[i]) throw Error("fixture digest mismatch");
      const dir = path.join(tmp, id),
        scope = { owner: "synthetic", project: "writer-regression" };
      execFileSync(
        process.execPath,
        [
          path.join(__dirname, "../../bin/memory.cjs"),
          "ingest",
          "--source",
          "dsh",
          "--file",
          file,
          "--instance",
          "synthetic",
          "--session",
          id,
          "--dir",
          dir,
          "--owner",
          scope.owner,
          "--project",
          scope.project,
        ],
        {
          env: { PATH: process.env.PATH, LANG: "C.UTF-8", TMPDIR: os.tmpdir() },
          stdio: "pipe",
        },
      );
      await migrateJsonToSqlite({ dir });
      const archive = await openArchive({ dir, readOnly: true });
      const selected = await selectLocalBatch(archive, scope);
      archive.close?.();
      if (selected.records.length !== 1 || !selected.records[0].projection)
        throw Error("selector mismatch");
      const records = selected.records,
        aliases = aliasInputs(records),
        prompt = render(aliases);
      if (Buffer.byteLength(prompt) > 1500 || hash(prompt) !== prompts[i])
        throw Error("prompt mismatch");
      const body = JSON.stringify(buildRequest(request(prompt), 384));
      slots.push({
        id,
        fixtureSha256: fixtures[i],
        promptSha256: hash(prompt),
        wireSha256: hash(body),
        wireBody: body,
        aliases,
        records,
      });
    }
    return slots;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
async function atomic(file, value) {
  const temp = file + ".tmp-" + crypto.randomUUID();
  try {
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
  }
}
function safeProxyStats(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const keys = [
    "requests",
    "terminalCompleted",
    "terminalIncomplete",
    "terminalFailed",
    "terminalCancelled",
    "missingTerminal",
    "providerOk",
    "providerFailed",
    "effortConfirmed",
    "effortUnreported",
    "unexpectedEffort",
    "missingModel",
    "unexpectedModel",
    "transportFailures",
  ];
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const result = Object.fromEntries(keys.map((k) => [k, count(s[k])]));
  result.usage = Object.fromEntries(
    ["input_tokens", "output_tokens", "total_tokens"].map((k) => [
      k,
      {
        reported: count(s.usage?.[k]?.reported),
        tokens: count(s.usage?.[k]?.tokens),
      },
    ]),
  );
  result.observedModels = Array.isArray(s.observedModels)
    ? s.observedModels
        .filter(
          (x) =>
            typeof x === "string" &&
            /^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(x),
        )
        .slice(0, 4)
    : null;
  return result;
}
function visibleOutput(payload) {
  const visible = [];
  let bytes = 0;
  if (Array.isArray(payload?.output))
    for (const message of payload.output) {
      if (
        message?.type !== "message" ||
        message?.role !== "assistant" ||
        !Array.isArray(message.content)
      )
        continue;
      for (const part of message.content) {
        const text =
          part?.type === "output_text"
            ? part.text
            : part?.type === "refusal"
              ? part.refusal
              : null;
        if (typeof text !== "string") continue;
        bytes += Buffer.byteLength(text);
        if (bytes > 65536 || visible.length >= 64)
          return { visible: null, limited: true };
        visible.push({ type: part.type, text });
      }
    }
  return { visible, limited: false };
}
async function live(
  slots,
  freeze,
  outDir,
  token,
  {
    fetchImpl = fetch,
    now = () => Date.now(),
    saveImpl = atomic,
    fallbackImpl = atomic,
    reportStats = (value) => console.error(JSON.stringify(value)),
  } = {},
) {
  if (JSON.stringify(freeze) !== JSON.stringify(sealedFreeze))
    throw Error("unapproved freeze");
  if (
    !Array.isArray(slots) ||
    slots.length !== 4 ||
    !Array.isArray(freeze) ||
    freeze.length !== 4 ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{24,128}$/.test(token)
  )
    throw Error("invalid run");
  if (
    JSON.stringify(
      slots.map((s) => ({
        id: s.id,
        wireSha256: s.wireSha256,
        wireBody: s.wireBody,
      })),
    ) !== JSON.stringify(freeze)
  )
    throw Error("freeze mismatch");
  if (JSON.stringify(slots) !== JSON.stringify(await prepare()))
    throw Error("source mapping mismatch");
  const dir = await fsp.realpath(outDir),
    st = await fsp.lstat(dir);
  if (
    path.dirname(dir) !== (await fsp.realpath(os.tmpdir())) ||
    !/^synthetic-luna-writer-results-[A-Za-z0-9]+$/.test(path.basename(dir)) ||
    !st.isDirectory() ||
    st.uid !== process.getuid() ||
    st.mode & 0o077
  )
    throw Error("private result directory required");
  const resultFile = path.join(dir, "luna-writer-result.json");
  try {
    await fsp.lstat(resultFile);
    throw Error("result exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const globalLock = path.join(
    await fsp.realpath(os.tmpdir()),
    `synthetic-luna-writer-${hash(JSON.stringify(sealedFreeze))}.once`,
  );
  const lock = await fsp.open(globalLock, "wx", 0o600);
  await lock.writeFile("public synthetic writer run\n");
  await lock.sync();
  await lock.close();
  const results = slots.map((s) => ({
    id: s.id,
    fixtureSha256: s.fixtureSha256,
    promptSha256: s.promptSha256,
    expectedWireSha256: s.wireSha256,
    sourceRecords: s.records,
    status: "not-sent",
    usage: null,
    providerStatus: null,
    rawOutput: null,
    visibleOutput: null,
    requestedModel: "gpt-6-luna",
    requestedEffort: "low",
    reportedModel: null,
    reportedEffort: null,
  }));
  let status = "running",
    proxyStats = null,
    failure = null;
  const save = () => saveImpl(resultFile, { status, results, proxyStats });
  const start = now(),
    base = "http://127.0.0.1:8080",
    headers = {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    };
  const stats = async () => {
    const r = await fetchImpl(base + "/stats", {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw Error("proxy stats unavailable");
    return r.json();
  };
  try {
    await save();
    const initial = await stats();
    proxyStats = safeProxyStats(initial);
    if (
      initial.requests !== 0 ||
      initial.limits?.requests !== 4 ||
      initial.limits?.outputTokens !== 384 ||
      initial.wireHashes?.length !== 0
    )
      throw Error("proxy not fresh or budget mismatch");
    for (let i = 0; i < 4; i++) {
      const remain = 360000 - (now() - start);
      if (remain <= 0) {
        status = "deadline";
        break;
      }
      const slot = slots[i];
      results[i].status = "sending";
      await save();
      let payload = null,
        metadata = null;
      try {
        const r = await fetchImpl(base + "/v1/responses", {
          method: "POST",
          headers,
          body: slot.wireBody,
          signal: AbortSignal.timeout(Math.min(75000, remain)),
        });
        payload = await r.json();
        const p = payload?.provider;
        metadata = safeMetadata(
          r.ok
            ? payload
            : {
                status: p?.providerStatus,
                incomplete_details: { reason: p?.incompleteReason },
                error: { code: p?.errorCode },
                usage: p?.usage,
              },
        );
        results[i].usage = metadata.usage;
        results[i].providerStatus = metadata.providerStatus;
        results[i].providerReason = metadata.incompleteReason;
        results[i].providerErrorCode = metadata.errorCode;
        const reportedModel = payload?.model;
        results[i].reportedModel =
          reportedModel == null
            ? null
            : typeof reportedModel === "string" &&
                /^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(reportedModel)
              ? reportedModel
              : "other";
        const effort = payload?.reasoning?.effort;
        results[i].reportedEffort =
          effort == null
            ? null
            : [
                  "none",
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                ].includes(effort)
              ? effort
              : "other";
        const visible = visibleOutput(payload);
        results[i].visibleOutput = visible.visible;
        const out =
          visible.visible
            ?.filter((x) => x.type === "output_text")
            .map((x) => x.text)
            .join("") || "";
        results[i].rawOutput = out || null;
        if (visible.limited) results[i].status = "visible-output-limit";
        else if (
          results[i].reportedModel === "other" ||
          (results[i].reportedEffort !== null &&
            results[i].reportedEffort !== "low")
        )
          results[i].status = "baseline-mismatch";
        else if (visible.visible?.some((x) => x.type === "refusal"))
          results[i].status = "refused";
        else if (
          !r.ok ||
          metadata.providerStatus !== "completed" ||
          !/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(payload?.model || "") ||
          !out
        )
          results[i].status = "unverified";
        else {
          try {
            results[i].candidates = mapOutput(
              JSON.parse(out),
              slot.aliases,
              slot.records,
            );
            results[i].status = "validated-needs-semantic-review";
          } catch {
            results[i].status = "invalid-output";
          }
        }
      } catch {
        results[i].status = "transport-failed";
      }
      await save();
      const observed = await stats();
      proxyStats = safeProxyStats(observed);
      results[i].proxyStats = proxyStats;
      results[i].actualWireSha256 =
        typeof observed.wireHashes?.[i] === "string" &&
        /^[a-f0-9]{64}$/.test(observed.wireHashes[i])
          ? observed.wireHashes[i]
          : null;
      if (
        observed.requests !== i + 1 ||
        results[i].actualWireSha256 !== slot.wireSha256
      ) {
        results[i].wireVerified = false;
        status = "wire-proof-failed";
        await save();
        break;
      }
      results[i].wireVerified = true;
      await save();
    }
    if (status === "running") status = "finished";
  } catch (error) {
    status = "runner-failed";
    failure = error;
  } finally {
    try {
      proxyStats = safeProxyStats(await stats());
    } catch {
      /* last observed snapshot stays available */
    }
    try {
      await save();
    } catch (error) {
      failure ||= error;
    }
    if (failure) {
      const safe = { status: "runner-failed", proxyStats };
      try {
        await fallbackImpl(
          path.join(dir, "luna-writer-proxy-stats.json"),
          safe,
        );
      } catch {
        try {
          reportStats(safe);
        } catch {
          /* Preserve the original error. */
        }
      }
    }
  }
  if (failure) throw failure;
  return { status, results, proxyStats };
}
module.exports = {
  adaptSchema,
  schema,
  request,
  mapOutput,
  prepare,
  live,
  hash,
};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--preflight")) {
    prepare()
      .then((slots) => {
        if (
          JSON.stringify(
            slots.map(({ id, wireSha256, wireBody }) => ({
              id,
              wireSha256,
              wireBody,
            })),
          ) !== JSON.stringify(sealedFreeze)
        )
          throw Error("freeze mismatch");
        console.log(
          JSON.stringify({
            status: "preflight-passed",
            modelCalls: 0,
            bodies: slots.map(({ id, promptSha256, wireSha256 }) => ({
              id,
              promptSha256,
              wireSha256,
            })),
          }),
        );
      })
      .catch(() => {
        console.error("preflight failed");
        process.exitCode = 1;
      });
  } else if (args.length === 2 && args[0] === "--run") {
    prepare()
      .then((slots) =>
        live(slots, sealedFreeze, args[1], process.env.MEMLAB_PROXY_TOKEN),
      )
      .then((result) => {
        console.log(
          JSON.stringify({
            status: result.status,
            slots: result.results.map(({ id, status, wireVerified }) => ({
              id,
              status,
              wireVerified,
            })),
          }),
        );
        if (result.status !== "finished") process.exitCode = 1;
      })
      .catch(() => {
        console.error("run failed; inspect private result receipt");
        process.exitCode = 1;
      });
  } else {
    console.error("Use --preflight or --run RESULT_DIRECTORY");
    process.exitCode = 2;
  }
}
