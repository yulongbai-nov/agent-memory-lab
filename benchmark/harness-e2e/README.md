# Cross-harness acceptance

The public workflow uses the pinned Linux Codex and DeepSeek Harness binaries in separate disposable containers. Loopback fixtures stand in for model providers and the CLI containers have no external network. The runner imports native session records and transfers the scoped archive through a temporary CouchDB to an independent replica. It verifies the original bytes separately from the CouchDB metadata and checks that records from another project stay out. Both CLIs must retrieve the randomized next-action marker through the real stdio memory MCP. Codex also checks the reviewed decision and both exact evidence revisions. The public lane measures protocol compatibility and makes zero model calls.

Use Node.js 24.22.1 for the host runner. DSH appends multiple Zstandard frames to a session. Older Node versions such as 24.12.0 can silently stop at the first frame, so the importer checks this capability before reading compressed history.

The trusted job requires manual dispatch from `main` and a successful public job for the same commit. It uses the `MEMORY_LUNA_API_KEY` Actions secret in the main-only `harness-e2e-protected` environment. DSH generates two synthetic native source sessions, then retrieves the next action from the replica through memory MCP. Codex reads the replica independently and must return the current decision, next action and two exact source citations with contiguous quotes. The runner checks upstream completion for each stage. The CLI containers can reach only the private test network. Only the proxy gets the OpenAI API key and external network access. ChatGPT credentials and personal profiles are outside this workflow.

The proxy accepts only OpenAI Responses requests with `gpt-6-luna` at `low`, sets `store: false`, and restricts tools to read-only memory calls. Limits per run are sixteen upstream requests (two DSH source turns and up to seven requests for each recall), 64 KiB per request and 384 KiB of total serialized request bodies. Output is capped at 512 model tokens per request, plus a 512 KiB transport response cap and 75-second per-request deadline. The upstream run expires six minutes after its first accepted request. Logs distinguish proxy refusals, provider authentication failures, model availability, rate limits, provider rejections and harness acceptance failures. Successful counters require a completed Responses event and the expected returned model. Usage sums include only reported fields, with counts and null for unreported totals. A successful credentials probe alone does not validate the harnesses.

The proxy preserves `tool_choice` modes `auto`, `none`, and `required`. Required mode needs a tool remaining after filtering. A forced function choice must name a directly declared, permitted read-only memory function. Unsupported choices return `tool-choice-rejected` before any upstream call. The refusal counter contains no argument values.

DSH uses the unchanged `dsh-synthetic-recall-v1` prompt. A transparent stdio observer records bounded timeline shape both before DSH serializes the real MCP response and from the CLI events. It emits parameter keys, paging, row kinds, known synthetic review IDs, byte counts, possible truncation and marker-presence flags. It never logs the marker value or answer text. Use the same prompt and fixture for later comparisons.

## Bounded memory contracts

The public Codex job also runs the bounded `memory_find` facade via real stdio MCP. The fixture reads the function from the native CLI's first Responses request, builds a set of calls from its schema, and drives them through the CLI using a loopback provider. It checks that the CLI continues after empty results and named argument errors, then finishes the turn.

Codex CLI 0.165.0 advertised the following function under `mcp__memory`, with `strict: false`. It retained the nullable types and optional fields. It omitted numeric and string-length constraints from the wire schema. The description retained those bounds, which the facade derives from the MCP schema.

```json
{
  "type": "object",
  "properties": {
    "keyword": { "type": ["string", "null"] },
    "limit": { "type": ["integer", "null"] }
  },
  "required": [],
  "additionalProperties": false
}
```

The [shared validator](../../src/bounded-memory-find.cts) publishes the MCP schema and validates calls against it. Missing, null, empty, or whitespace-only keywords search within the configured view without a keyword. Other strings are trimmed and can include Chinese characters, spaces, and punctuation. The limit is 60 Unicode code points, at most 240 UTF-8 bytes. A missing or null result limit defaults to 5. Integer limits from 1 through 10,000 are accepted and clamped to 5, with the effective limit returned. No matches and named argument errors both use normal MCP tool results. Diagnostics contain parameter types, empty status, character and byte counts, numeric limits, the failed constraint, and whether MCP and the lookup ran. Each call records its final outcome (found, empty, lookup-failed, or rejected), returned count, and effective limit after the lookup settles. They omit keyword text and unexpected property names.

A bounded local binding passes `createBoundedFind(scopedLookup, report)` as `findTool` in the options to `startMcp`. It can pass the [follow-up factories](../../src/bounded-memory-read.cts) as `timelineTool` and `evidenceTool`. The default MCP routes keep their existing contracts.

| Bounded tool | Required fields | Access |
| --- | --- | --- |
| `memory_timeline` | `topic` (string) | Exact topic alias issued by `memory_find`. |
| `memory_evidence` | `id` and `revision` (strings) | Exact pair issued by `memory_timeline`. |

The follow-up tools have no optional fields or defaults. Nulls, paging, filters, and extra fields return `invalid-arguments`. An unissued alias or pair gets a normal tool result with `topic-not-issued` or `citation-not-issued`. All three bounded tools map lookup exceptions to `lookup-failed` without exposing exception messages. The binding owns scope, source mapping, and issued aliases. A relay can take each description and schema from the same factory and keep tool registration, call and result verification, and egress limits separate from argument validation.

The public suite runs a separate [three-tool native replay](codex/read-contract.cjs) through the [shared bounded relay and stdio MCP binding](../../lib/bounded-memory-relay.cjs). It seeds a fresh synthetic archive and replaces the upstream provider with loopback responses. The CLI must use issued topic and citation aliases, recover from empty results, invalid arguments, and backend failures, and finish the turn with a verified fixture excerpt. Each outgoing request is checked for the injected backend sentinel. The relay verifies a content-free receipt from the MCP process for each tool call and rejects tampering, receipt reuse under a different call ID, and over-budget excerpt egress. Private launchers can supply their own scoped backend and prompt to the same implementation.

The relay counts serialized excerpts and replayed plaintext together against one cumulative 4 KiB budget. Starting with the first request that contains an excerpt, it conservatively charges all replayed function arguments and model-supplied IDs, including calls the MCP rejected and requests that omit the earlier excerpt. After an excerpt is sent, assistant text, nonempty reasoning summaries, and any plaintext reasoning content also count toward the same limit. Diagnostics distinguish raw excerpt bytes, serialized excerpt bytes, echo bytes, opaque reasoning bytes, and the total charged. The synthetic regression checks that a 5,200-byte echo of a 26-byte excerpt is rejected before the fake upstream is called, while a normal argument error is forwarded.

Before signing timeline and evidence results, the MCP binding projects timestamps to canonical ISO strings. The stored source records are left intact. The synthetic replay passes the same date with a 5,200-byte comment through both paths and checks that the comment never appears in an upstream request. This binding emits no navigation labels. Timeline rows carry issued aliases and timestamps, and scoped private backends must supply the sanitized excerpt to the evidence binding.

The bounded relay starts with a fixed projected user prompt, tool catalog, instructions, output schema, and tool settings. With `store: false`, each continuation retains the exact approved input prefix, appends the previous provider response items in order, and appends the corresponding signed MCP results in call order. The relay forwards the original approved provider objects. The pinned native CLI can omit status or an empty reasoning content array, and can represent absent reasoning fields as null. The relay recognizes only these observed serialization differences, then replays the exact approved provider object. Missing nonempty content, altered ciphertext or summaries, and reordered history are rejected. Opaque encrypted reasoning remains in memory and counts toward the 64 KiB request cap. It is neither decrypted nor logged. The synthetic native replay checks continuity after an excerpt, including an assistant commentary message and a nonempty reasoning summary, and exercises rejection for tampering, history changes, and both byte limits. See the [OpenAI stateless reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses) and [prefix guidance](https://developers.openai.com/api/docs/guides/preserved-reasoning).

## Local proxy

Run the following only for an explicitly authorized synthetic experiment. The process listens on loopback and reads the single `OPENAI_API_KEY=…` entry from `~/.local/share/agent-memory-lab/credentials/openai.env`. The credential file must be owned by the current user with mode 0600. Use a new gate token for each process and pass only that token to the test client.

```sh
export MEMLAB_PROXY_TOKEN="$(openssl rand -hex 24)"
node benchmark/harness-e2e/openai-proxy.cjs --local-env-file
```
