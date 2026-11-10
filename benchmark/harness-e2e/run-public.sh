#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TMP_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM
mkdir -m 700 "$TMP_ROOT/dsh"
"$ROOT/benchmark/harness-e2e/run-codex.sh"
"$ROOT/benchmark/harness-e2e/run-dsh.sh" "$TMP_ROOT/dsh"
node "$ROOT/benchmark/harness-e2e/prepare-fixture.cjs" "$TMP_ROOT/dsh/sessions" "$TMP_ROOT/source"
node "$ROOT/benchmark/harness-e2e/handoff.cjs" "$TMP_ROOT/source" "$TMP_ROOT/replica"
"$ROOT/benchmark/harness-e2e/run-recall.sh" "$TMP_ROOT/replica"
"$ROOT/benchmark/harness-e2e/run-dsh-recall.sh" "$TMP_ROOT/replica"
"$ROOT/benchmark/harness-e2e/run-dsh-provider-mock.sh"
