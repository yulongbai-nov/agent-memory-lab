# Cross-harness acceptance

The public workflow uses the pinned Linux Codex and DeepSeek Harness binaries in separate disposable containers. Loopback fixtures stand in for model providers and the CLI containers have no external network. The runner imports native session records and transfers the scoped archive through a temporary CouchDB to an independent replica. It verifies the original bytes separately from the CouchDB metadata and checks that records from another project stay out. Both CLIs must retrieve the randomized next-action marker through the real stdio memory MCP. Codex also checks the reviewed decision and both exact evidence revisions. The public lane measures protocol compatibility and makes zero model calls.

The trusted job requires manual dispatch from `main` and a successful public job for the same commit. It uses the `MEMORY_LUNA_API_KEY` Actions secret in the main-only `harness-e2e-protected` environment. DSH generates two synthetic native source sessions, then retrieves the next action from the replica through memory MCP. Codex reads the replica independently and must return the current decision, next action and two exact source citations with contiguous quotes. The runner checks upstream completion for each stage. The CLI containers can reach only the private test network. Only the proxy gets the OpenAI API key and external network access. ChatGPT credentials and personal profiles are outside this workflow.

The proxy accepts only OpenAI Responses requests with `gpt-6-luna` at `low`, sets `store: false`, and restricts tools to read-only memory calls. Limits per run are sixteen upstream requests (two DSH source turns and up to seven requests for each recall), 64 KiB per request and 384 KiB of total serialized request bodies. Output is capped at 512 model tokens per request, plus a 512 KiB transport response cap and 75-second per-request deadline. The upstream run expires six minutes after its first accepted request. Logs distinguish proxy refusals, provider authentication failures, model availability, rate limits, provider rejections and harness acceptance failures. Successful counters require a completed Responses event and the expected returned model. Usage sums include only reported fields, with counts and null for unreported totals. A successful credentials probe alone does not validate the harnesses.

## Local proxy

Run the following only for an explicitly authorized synthetic experiment. The process listens on loopback and reads the single `OPENAI_API_KEY=…` entry from `~/.local/share/agent-memory-lab/credentials/openai.env`. The credential file must be owned by the current user with mode 0600. Use a new gate token for each process and pass only that token to the test client.

```sh
export MEMLAB_PROXY_TOKEN="$(openssl rand -hex 24)"
node benchmark/harness-e2e/openai-proxy.cjs --local-env-file
```
