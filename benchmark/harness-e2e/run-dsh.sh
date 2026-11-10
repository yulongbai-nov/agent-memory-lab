#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUTPUT=${1:?empty synthetic output directory required}
[ -d "$OUTPUT" ] && [ -z "$(ls -A "$OUTPUT")" ] || { echo 'BLOCKED: output directory must be empty'; exit 1; }
IMAGE=agent-memory-lab-dsh-synthetic:0.2.2-rc.1
CONTAINER=
cleanup() { if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT INT TERM
docker build -t "$IMAGE" "$ROOT/benchmark/harness-e2e/dsh"
CONTAINER=$(docker create --network none --memory 2g --cpus 2 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges "$IMAGE")
docker start -a "$CONTAINER"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER")" = 0 ]
docker cp "$CONTAINER:/out/." "$OUTPUT/"
