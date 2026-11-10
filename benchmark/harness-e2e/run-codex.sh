#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUTPUT=$(mktemp -d)
CONTAINER=
cleanup() { if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi; rm -rf "$OUTPUT"; }
trap cleanup EXIT INT TERM
IMAGE=agent-memory-lab-codex-synthetic:0.165.0
docker build -f "$ROOT/benchmark/harness-e2e/codex/Dockerfile" -t "$IMAGE" "$ROOT/benchmark/harness-e2e/codex"
CONTAINER=$(docker create --network none --memory 2g --cpus 2 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges "$IMAGE")
docker start -a "$CONTAINER"
docker cp "$CONTAINER:/out/codex-session.jsonl" "$OUTPUT/codex-session.jsonl"
node "$ROOT/benchmark/harness-e2e/check-codex.cjs" "$OUTPUT/codex-session.jsonl"
