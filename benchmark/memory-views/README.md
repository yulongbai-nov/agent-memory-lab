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

## Bounded retrieval check

Run `npm run benchmark:memory-views -- --retrieval`. This mode performs zero model calls. It uses the same synthetic source and review ledger for all views, with three extra unreviewed same-topic records, an unrelated topic, and a competing source with the same item ID in another project. The file view checks the scope of its candidates, and the other two use the scoped archive.

Each native view supplies its own candidates in retrieval order. A shared lexical score uses words from the question and the source or attached review fields. Ties retain the native order. The common packer selects at most three source versions and 1,900 UTF-8 bytes of JSON context. Review records enter the context only when their exact source versions fit. Required reference sets are used only after selection to measure coverage. The report also checks exact revision resolution and detects any cross-project reference. The topic is supplied to all three views. This tests the specified small corpus and selection policy, with no claim about full-corpus retrieval or a framework advantage.
