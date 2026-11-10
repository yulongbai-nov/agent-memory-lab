#!/bin/sh
# Invoke only in the trusted manual job or by an explicitly authorized operator.
set -eu
if [ -z "${MEMORY_LUNA_API_KEY:-}" ]; then
  printf '%s\n' 'BLOCKED: MEMORY_LUNA_API_KEY is unavailable.'
  exit 3
fi
proxy_key=$MEMORY_LUNA_API_KEY
unset MEMORY_LUNA_API_KEY
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
HARNESS="$ROOT/benchmark/harness-e2e"
if [ ! -f "$HARNESS/handoff.cjs" ]; then
  printf '%s\n' 'BLOCKED: the synthetic CouchDB handoff is unavailable.'
  exit 3
fi
clean() { env -u MEMORY_LUNA_API_KEY "$@"; }
dock() { clean docker "$@"; }
RUN=$(clean node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')
MEMLAB_PROXY_TOKEN=$(clean node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
export MEMLAB_PROXY_TOKEN
WORK=$(mktemp -d)
NETWORK="memlab-luna-$RUN"
DSH_IMAGE="memlab-trusted-dsh:$RUN"
CODEX_IMAGE="memlab-trusted-codex:$RUN"
FIXTURE_IMAGE="memlab-trusted-fixture:$RUN"
DSH_FIXTURE_IMAGE="memlab-trusted-dsh-fixture:$RUN"
PROXY_IMAGE="memlab-trusted-proxy:$RUN"
PROXY="memlab-proxy-$RUN"
DSH="memlab-dsh-$RUN"
DSH_RECALL="memlab-dsh-recall-$RUN"
CODEX="memlab-codex-$RUN"
STAGING="memlab-stage-$RUN"
NODE_IMAGE=node:24.12.0-bookworm-slim
cleanup() {
  dock rm -f "$CODEX" "$DSH" "$DSH_RECALL" "$PROXY" "$STAGING" >/dev/null 2>&1 || true
  dock network rm "$NETWORK" >/dev/null 2>&1 || true
  dock image rm "$FIXTURE_IMAGE" "$DSH_FIXTURE_IMAGE" "$PROXY_IMAGE" "$CODEX_IMAGE" "$DSH_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
# Keys are excluded from both builds and the CLI containers.
dock build -t "$DSH_IMAGE" "$HARNESS/dsh"
dock build -t "$CODEX_IMAGE" "$HARNESS/codex"
mkdir "$WORK/proxy"
cp "$HARNESS/openai-proxy.cjs" "$WORK/proxy/"
printf 'FROM %s\nCOPY openai-proxy.cjs /opt/openai-proxy.cjs\nUSER node\n' "$NODE_IMAGE" |
  dock build -f - -t "$PROXY_IMAGE" "$WORK/proxy"
dock network create --internal --subnet 172.28.88.0/24 "$NETWORK" >/dev/null
MEMORY_LUNA_API_KEY="$proxy_key" docker create --name "$PROXY" --network "$NETWORK" --ip 172.28.88.2 --memory 512m --cpus 1 --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  -e MEMORY_LUNA_API_KEY -e MEMLAB_PROXY_TOKEN -e MEMLAB_PROXY_HOST=172.28.88.2 \
  --entrypoint node "$PROXY_IMAGE" /opt/openai-proxy.cjs >/dev/null
unset proxy_key
# Only the proxy gets an egress-capable network. The clients stay internal.
dock network connect bridge "$PROXY"
dock start "$PROXY" >/dev/null
proxy_stats() {
  dock run --rm --network "$NETWORK" --memory 128m --pids-limit 32 --cap-drop ALL \
    --security-opt no-new-privileges --read-only -e MEMLAB_PROXY_TOKEN "$NODE_IMAGE" node -e '
    fetch("http://172.28.88.2:8080/stats",{headers:{Authorization:"Bearer "+process.env.MEMLAB_PROXY_TOKEN},signal:AbortSignal.timeout(3000)})
      .then(r=>{if(!r.ok)throw Error();return r.json()}).then(x=>{if(x.requestedModel!=="gpt-6-luna"||x.requestedEffort!=="low")throw Error();console.log(JSON.stringify(x));})
      .catch(()=>{process.exitCode=1});'
}
assert_proxy_stage() {
  clean node -e '
    const x=JSON.parse(process.argv[1]), prior=Number(process.argv[2]), required=Number(process.argv[3]);
    if(x.providerOk<prior+required||x.providerOk>prior+Number(process.argv[4])||x.providerOk!==x.requests||
       x.providerFailed!==0||x.gateRejections!==0||x.budgetRefusals!==0||x.deadlineRefusals!==0||
       x.requests>x.limits.requests)process.exitCode=1;
  ' "$1" "$2" "$3" "$4"
}
if ! baseline=$(proxy_stats) || ! assert_proxy_stage "$baseline" 0 0 0; then
  printf '%s\n' 'BLOCKED: bounded proxy readiness failed before harness runs.'
  exit 3
fi
dock create --name "$DSH" --network "$NETWORK" --memory 2g --cpus 2 --pids-limit 128 --cap-drop ALL \
  --security-opt no-new-privileges -e MEMLAB_PROXY_TOKEN --entrypoint node "$DSH_IMAGE" /opt/dsh-test/run.cjs >/dev/null
if ! dock start -a "$DSH" || [ "$(dock inspect -f '{{.State.ExitCode}}' "$DSH")" != 0 ]; then
  proxy_stats || true
  printf '%s\n' 'BLOCKED: DSH provider-backed native source turns failed.'
  exit 1
fi
if ! after_dsh=$(proxy_stats) || ! assert_proxy_stage "$after_dsh" 0 2 2; then
  printf '%s\n' "${after_dsh:-}"
  printf '%s\n' 'BLOCKED: DSH did not complete two upstream model requests within budget.'
  exit 1
fi
printf '%s\n' "$after_dsh"
mkdir "$WORK/dsh-output"
dock cp "$DSH:/out/." "$WORK/dsh-output/"
clean node "$HARNESS/prepare-fixture.cjs" "$WORK/dsh-output/sessions" "$WORK/source"
clean node "$HARNESS/handoff.cjs" "$WORK/source" "$WORK/replica"
mkdir "$WORK/runtime"
cp -R "$ROOT/bin" "$ROOT/lib" "$ROOT/node_modules" "$WORK/runtime/"
cp "$ROOT/package.json" "$WORK/runtime/"
stage_fixture() {
  dock create --name "$STAGING" --network none --user root --entrypoint sh "$1" \
    -c 'chown -R "$1" /archive /memory && chmod 700 /archive && chmod 600 /archive/archive.json' sh "$3" >/dev/null
  dock cp "$WORK/runtime/." "$STAGING:/memory/"
  dock cp "$WORK/replica/." "$STAGING:/archive/"
  dock start -a "$STAGING"
  [ "$(dock inspect -f '{{.State.ExitCode}}' "$STAGING")" = 0 ]
  dock commit "$STAGING" "$2" >/dev/null
  dock rm "$STAGING" >/dev/null
}
stage_fixture "$CODEX_IMAGE" "$FIXTURE_IMAGE" root:root
stage_fixture "$DSH_IMAGE" "$DSH_FIXTURE_IMAGE" node:node
dock create --name "$DSH_RECALL" --network "$NETWORK" --user node --memory 2g --cpus 2 --pids-limit 128 \
  --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:mode=1777 \
  -e HOME=/tmp -e MEMLAB_PROXY_TOKEN -e MEMLAB_RECALL_MODE=provider \
  --entrypoint node "$DSH_FIXTURE_IMAGE" /opt/dsh-test/recall.cjs >/dev/null
if ! dock start -a "$DSH_RECALL" || [ "$(dock inspect -f '{{.State.ExitCode}}' "$DSH_RECALL")" != 0 ]; then
  proxy_stats || true
  printf '%s\n' 'BLOCKED: DSH provider-backed memory recall failed.'
  exit 1
fi
if ! after_recall=$(proxy_stats) || ! assert_proxy_stage "$after_recall" 2 2 7; then
  printf '%s\n' "${after_recall:-}"
  printf '%s\n' 'BLOCKED: DSH recall did not complete its upstream model requests within budget.'
  exit 1
fi
printf '%s\n' "$after_recall"
recall_requests=$(clean node -p 'JSON.parse(process.argv[1]).requests' "$after_recall")
dock create --name "$CODEX" --network "$NETWORK" --memory 2g --cpus 2 --pids-limit 128 --cap-drop ALL \
  --security-opt no-new-privileges --read-only --tmpfs /work:mode=0700 \
  --tmpfs /tmp:mode=1777 -e HOME=/tmp -e MEMLAB_PROXY_TOKEN -e MEMLAB_RECALL_MODE=provider \
  --entrypoint node "$FIXTURE_IMAGE" /opt/recall.cjs >/dev/null
if ! dock start -a "$CODEX" || [ "$(dock inspect -f '{{.State.ExitCode}}' "$CODEX")" != 0 ]; then
  proxy_stats || true
  printf '%s\n' 'BLOCKED: Codex provider-backed recall/tool/evidence acceptance failed.'
  exit 1
fi
if ! final=$(proxy_stats) || ! assert_proxy_stage "$final" "$recall_requests" 2 7; then
  printf '%s\n' "${final:-}"
  printf '%s\n' 'BLOCKED: Codex did not complete an upstream model request within budget.'
  exit 1
fi
printf '%s\n' "$final"
