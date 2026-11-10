#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TMP_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM
mkdir -m 700 "$TMP_ROOT/dsh"
echo "STAGE: codex-native"
"$ROOT/benchmark/harness-e2e/run-codex.sh"
echo "STAGE: dsh-native"
"$ROOT/benchmark/harness-e2e/run-dsh.sh" "$TMP_ROOT/dsh"
echo "STAGE: fixture"
node "$ROOT/benchmark/harness-e2e/prepare-fixture.cjs" "$TMP_ROOT/dsh/sessions" "$TMP_ROOT/source"
echo "STAGE: couch-handoff"
node "$ROOT/benchmark/harness-e2e/handoff.cjs" "$TMP_ROOT/source" "$TMP_ROOT/replica"
echo "STAGE: codex-mcp"
"$ROOT/benchmark/harness-e2e/run-recall.sh" "$TMP_ROOT/replica"
echo "STAGE: dsh-mcp"
"$ROOT/benchmark/harness-e2e/run-dsh-recall.sh" "$TMP_ROOT/replica"
echo "STAGE: dsh-provider-wire"
"$ROOT/benchmark/harness-e2e/run-dsh-provider-mock.sh"
