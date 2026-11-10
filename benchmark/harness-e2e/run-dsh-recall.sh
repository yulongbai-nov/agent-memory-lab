#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ARCHIVE=${1:?synthetic archive directory required}
[ -f "$ARCHIVE/.synthetic-harness-fixture" ] || { echo 'BLOCKED: synthetic fixture marker required'; exit 1; }
IMAGE=agent-memory-lab-dsh-synthetic:0.2.2-rc.1
FIXTURE_IMAGE="agent-memory-dsh-fixture:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
CONTAINER=
cleanup() { if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi; docker image rm "$FIXTURE_IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker build -t "$IMAGE" "$ROOT/benchmark/harness-e2e/dsh"
CONTAINER=$(docker create --network none --user root --entrypoint sh "$IMAGE" -c 'mkdir -p /memory /archive; chown -R node:node /memory /archive; chmod 700 /archive')
docker start -a "$CONTAINER"
for item in lib bin node_modules package.json; do docker cp "$ROOT/$item" "$CONTAINER:/memory/" >/dev/null; done
docker cp "$ARCHIVE/." "$CONTAINER:/archive/" >/dev/null
docker start -a "$CONTAINER"
docker commit "$CONTAINER" "$FIXTURE_IMAGE" >/dev/null
docker rm "$CONTAINER" >/dev/null
CONTAINER=
docker run --rm --network none --user 1000:1000 --read-only --tmpfs /tmp:mode=1777 --memory 2g --cpus 2 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges -e HOME=/tmp --entrypoint node "$FIXTURE_IMAGE" /opt/dsh-test/recall.cjs
