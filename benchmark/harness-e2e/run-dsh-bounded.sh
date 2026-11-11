#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
IMAGE=agent-memory-lab-dsh-synthetic:0.2.2-rc.1
FIXTURE_IMAGE="agent-memory-dsh-bounded:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
CONTAINER=
cleanup() { if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi; docker image rm "$FIXTURE_IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker build -t "$IMAGE" "$ROOT/benchmark/harness-e2e/dsh"
CONTAINER=$(docker create --network none --user root --entrypoint sh "$IMAGE" -c 'mkdir -p /memory/benchmark/harness-e2e/dsh; chown -R node:node /memory')
docker start -a "$CONTAINER"
for item in lib node_modules; do docker cp "$ROOT/$item" "$CONTAINER:/memory/" >/dev/null; done
for item in bounded-contract.cjs provider.patch.yml; do docker cp "$ROOT/benchmark/harness-e2e/dsh/$item" "$CONTAINER:/memory/benchmark/harness-e2e/dsh/" >/dev/null; done
docker commit "$CONTAINER" "$FIXTURE_IMAGE" >/dev/null
docker rm "$CONTAINER" >/dev/null
CONTAINER=
docker run --rm --network none --user 1000:1000 --read-only --tmpfs /tmp:rw,exec,mode=1777 --memory 2g --cpus 2 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$FIXTURE_IMAGE" /memory/benchmark/harness-e2e/dsh/bounded-contract.cjs /opt/dsh-test/node_modules/.bin/dsh
