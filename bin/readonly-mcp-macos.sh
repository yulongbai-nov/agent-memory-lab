#!/bin/sh
# Run the ordinary read-only memory tool process under macOS file-write confinement.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
for arg do
  if test "$arg" = '--allow-annotations'; then
    printf '%s\n' 'This service exposes read-only tools.' >&2
    exit 2
  fi
done
unset MEMORY_LAB_COUCH_AUTHORIZATION
exec /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny file-write*) (deny network*) (deny file-read-data (regex #"/originals/[^/]+$"))' \
  node "$root/bin/memory.cjs" mcp "$@"
