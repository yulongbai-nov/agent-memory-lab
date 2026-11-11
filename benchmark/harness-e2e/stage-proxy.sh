#!/bin/sh
# Shared zero-secret staging for the trusted proxy image and its smoke test.
set -eu
if [ "$#" -ne 2 ]; then exit 2; fi
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
mkdir "$1"
cp "$HERE/openai-proxy.cjs" "$1/"
cp "$HERE/response-metadata.cjs" "$1/"
printf 'FROM %s\nCOPY openai-proxy.cjs response-metadata.cjs /opt/\nUSER node\n' "$2" > "$1/Dockerfile"
