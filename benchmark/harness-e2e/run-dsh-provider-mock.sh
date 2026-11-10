#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TMP_ROOT=$(mktemp -d)
NET="memlab-wire-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
PROXY= DSH=
cleanup() { [ -z "$DSH" ] || docker rm -f "$DSH" >/dev/null 2>&1 || true; [ -z "$PROXY" ] || docker rm -f "$PROXY" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM
TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')
printf 'MEMLAB_PROXY_TOKEN=%s\n' "$TOKEN" > "$TMP_ROOT/env"; chmod 600 "$TMP_ROOT/env"
IMAGE=agent-memory-lab-dsh-synthetic:0.2.2-rc.1
docker build -t "$IMAGE" "$ROOT/benchmark/harness-e2e/dsh"
docker network create --internal --subnet 172.28.88.0/24 "$NET" >/dev/null
PROXY=$(docker create --network "$NET" --ip 172.28.88.2 --env-file "$TMP_ROOT/env" --entrypoint node "$IMAGE" /tmp/fake-proxy.cjs)
docker cp "$ROOT/benchmark/harness-e2e/dsh/fake-proxy.cjs" "$PROXY:/tmp/fake-proxy.cjs" >/dev/null
docker start "$PROXY" >/dev/null
DSH=$(docker create --network "$NET" --env-file "$TMP_ROOT/env" --memory 2g --cpus 2 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$IMAGE" /opt/dsh-test/run.cjs)
docker start -a "$DSH" || true
docker logs "$PROXY"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$DSH")" = 0 ]
