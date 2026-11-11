# DeepSeek Harness headless fixture

Run `benchmark/harness-e2e/run-dsh.sh EMPTY_OUTPUT_DIRECTORY` from the repository root. It builds the pinned Linux `@deepseek-ai/dsh@0.2.2-rc.1` CLI, then starts two isolated headless sessions with a loopback Messages fixture. The container has no external network and uses disposable profiles. It produces two native session records and their CLI event streams. The local mock speaks the provider protocol and makes no inference calls.

The separate trusted runner starts `/opt/dsh-test/run.cjs` explicitly. It uses a temporary gate token, a fixed private-network proxy, and the DSH OpenAI Responses adapter. Source generation uses two independent prompts and disables registered native tools and auxiliary title inference. Only the test proxy receives the upstream credential. The importer checks both native session records for completed assistant turns and verifies the captured original user bytes.

Builds fetch the version-pinned official package from npm. The Node base image is pinned by release tag. The [tagged DSH CLI documentation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/apps/cli/README.md) describes the headless entry point and profiles.

The synthetic bounded Responses replay is `node bounded-contract.cjs <absolute-path-to-dsh>` with DSH 0.2.2-rc.1. Run it only inside a disposable environment that blocks access to user profiles and credentials and restricts outbound network to loopback. It creates a synthetic archive and profile, uses a fake local provider, and exercises find, timeline, and evidence through the bounded relay. The script does not itself enforce the operating-system network boundary. A macOS run is separate evidence from the Linux container gates.
