# Synthetic memory-view comparison

Run `npm ci --ignore-scripts`, `npm run build`, then `npm run benchmark:memory-views`. Ripgrep is required. The default run performs no model or network calls. The explicit `--live` variant is for a separately authorized synthetic experiment and uses the existing bounded loopback Responses proxy.

## Protocol

Four fixed questions test a confirmed decision, correction versus change, the action that depends on a decision, and whether a historical knowledge state can be established. Each question is answered once per arm. The model is fixed at `gpt-6-luna` with low reasoning effort. The same prompt version, output schema and scoring rule apply in every arm. Source and review records come from one temporary archive. The approved dependency record is supplied to all views.

- **Reconstructed November file baseline.** Ripgrep reads the synthetic Markdown journal and review ledger by the selected topic. The historical design describes a file-based workflow. The original runnable retriever was unavailable.
- **Structured query.** The product timeline selects sources and review records. The same dependency sidecar is joined by scoped review ID.
- **Graph projection.** The product graph traverses the selected topic's nodes and explicit links, then resolves their source and review rows. Its computed answer is not sent to the reader.

The dry run enforces the same complete evidence multiset, revision references, and byte budget. A common reader serializer preserves each view's retrieval order. This deliberately isolates presentation and retrieval overhead on this fixture. It does not test topic discovery, retrieval recall on a large corpus, a semantic graph writer, or a general ranking advantage. The approved facts remain unchanged. No raw private data, historical metrics, or extra answer keys enter the prompts.

The report separates shared archive setup, per-view construction, retrieval time and bytes, and per-call answer latency, token usage, answer correctness, and exact citation-set correctness. Construction and retrieval use no model tokens. The 12 requests are single-attempt, with rotated arm order and no retries. The proxy caps each body at 64 KiB, all request bodies at 384 KiB, each answer at 512 output tokens, each request at 75 seconds, and the upstream window at six minutes. The run has the existing 16-request hard cap and a 12-case experiment limit.

Exact citation-set correctness means equality to the preregistered reference set. Extra or alternative references can be valid evidence even when this score fails. The original trial did not retain answers or citations, so its individual failures cannot be reclassified. Future authorized runs retain only the final validated `status`, `facts`, and `citations` alongside the expected references and scores. This applies to the fixed synthetic fixture and excludes HTTP headers, credentials, and raw provider responses.

## Five-question bounded retrieval check

Run `npm run benchmark:memory-views -- --retrieval` or `npm run check:memory-retrieval`. This separate no-model cohort uses five fixed questions in `retrieval-spec.json`; `retrieval-oracle.json` is loaded only after every view has retrieved and packed its context. The older default and `--live` modes above remain the four-question experiment; they are not reader evaluations of the new five-question cohort.

The fixture includes the original decision, correction, open task, actual change, a separate confirmation of the changed slot, and a dependency with both effective and recorded knowledge times. It also contains unreviewed same-topic distractions, another topic and a same-ID, different-project collision. The three views use the same scoped source and review corpus but retain their own candidate retrieval differences. The file view can encounter the foreign candidate; its occurrence is reported and the shared packer excludes every out-of-scope source, review and relation before reader context is produced.

A common lexical ranker uses the question and candidate text; ties sort by the complete scope, harness, instance, session, item and exact revision reference. The same serializer and limits apply to all groups: at most three source versions and 1,900 UTF-8 bytes, including attached reviews and relation records. Review pointers are indexes into the supplied source references. The check first constructs contexts without the oracle, then verifies that at least one sufficient support set per question fits the budget. Candidate support, selected support, bytes, unresolved references and cross-scope candidates are reported separately. Alternative equivalent sources are accepted only where the oracle specifies them; the named historical reschedule and the dependency's own approved, timed relation require their original evidence.

The check repeats in two fresh temporary archives and asserts exact reference resolution, deterministic selection, valid scope, alternative and missing support, unknown correction knowledge time, and both dependency knowledge cutoffs. It makes no claims about reader accuracy, graph-framework performance or general recall, and performs no model calls. A future reader experiment needs separately authorized execution and a shared five-question input/output contract.

## Structured evidence-bundle experiment

The five-question retrieval report also shows a separate `structured-bundle` group using the same structured candidates and the same source and byte caps. It receives an explicit request kind and timestamps for temporal comparison or open dependencies; it does not infer intent from question wording. The original file, structured lexical and graph groups remain unchanged. Unsupported request types and unsupported or ambiguous temporal relationships return `unknown`; a bundle exceeding the cap returns `insufficient` with no partial evidence.

The temporal request is retrospective by default and does not claim the review was known at the historical valid time. If a knowledge cutoff is explicitly supplied for that request, selected reviews must have a known time by that cutoff. For dependency requests, the cutoff constrains the dependency relationship; the decision and task are read from the current reviewed archive. A review's explicit effective time, or otherwise its cited source time, supplies a lower bound. Multiple competing change heads or unsupported revision chains are reported as unknown rather than silently resolved. The additional group does not constitute a product interface or a model evaluation.

The independent held-out tests reuse the same lexical selector with identical scoped rows and caps for comparison, alongside the explicit request for the bundle. The lexical results are recorded as diagnostics rather than a requirement that the baseline fail. The held-out cases also exercise time cutoffs, missing or contradictory evidence, renamed IDs, ordering, and insufficient budgets.

## Synthetic short-reference preflight

`node benchmark/memory-views/paired-alias-preflight.cjs --preflight [output]` constructs the same four pairs and chooses the same evidence under the existing 3-reference/1,900-byte limit before changing presentation. It changes only each source's displayed reference to a case-and-arm-bound short alias; source text, review metadata, numeric links, question, instructions, and JSON schema remain unchanged. No citation enum is provided. The application-side map retains the complete scoped source revision and rejects unknown, mismatched, duplicate or cross-package mappings; decoded citations are restored to the original reference before scoring. These aliases are display-only and are not durable source identifiers.

The preflight command uses a fake upstream only. It records the full synthetic forwarded bodies and hashes, independently substitutes every scoring-oracle item in isolated processes, and checks an intentional oracle-leak negative control. The separate long-reference experiment and its previous real results are unchanged. The separate `paired-alias-live.cjs` can freeze an eight-slot comparison against the recorded synthetic baseline; its explicit live mode requires a fresh hash-capable bounded proxy, a content-derived one-shot lock and a new result file. Tests remain zero-model. Preflight and independent review precede any separately initiated run.

The repository includes `paired-baseline-receipt.json`: eight public synthetic original request bodies, each with its original SHA-256 and the source result file's SHA-256. It contains no model answers or usage. The receipt's own SHA-256 is pinned in the runner. It permits a fresh checkout to repeat the **zero-model** comparison without the historical result file:

```sh
npm ci --ignore-scripts
npm run build
node benchmark/memory-views/paired-alias-live.cjs --preflight \
  benchmark/memory-views/paired-baseline-receipt.json /tmp/paired-alias-freeze.json
```

The command refuses an existing output file. It checks that alias reversal reconstructs all eight original forwarded bodies and that isolated oracle substitutions and per-case leak controls behave as expected. The optional original result file remains accepted only at its pinned hash. This receipt reproduces request parity, not any model answer, usage record, real-network delivery, or claim of statistical improvement. A live run is separate and explicitly enabled; the proxy records only safe outgoing-body hashes, and a missing or mismatched hash stops later slots.

The source-result hash in the baseline receipt identifies the earlier long-reference synthetic result. The later short-reference model trial was performed with commit `8b7d446ebc18354f478d04d5664e2c2ed2da6809`; this packaging change was not used in that trial. A fresh preflight verifies request equivalence only and does not recreate or modify either historical result.
