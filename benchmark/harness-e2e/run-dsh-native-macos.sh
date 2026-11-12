#!/bin/sh
# Optional synthetic replay with the installed native macOS DSH executable.
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'macOS required' >&2; exit 1; }
[ "$#" -eq 1 ] && [ "${1#/}" != "$1" ] && [ -x "$1" ] || { echo 'Provide an absolute path to the trusted DSH executable' >&2; exit 1; }
cli=$1
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
node=$(command -v node)
account_dir=$("$node" -p 'require("node:fs").realpathSync(require("node:os").userInfo().homedir)')
# The sandbox policy is constructed from paths, so reject syntax characters.
case "$root$account_dir" in *'"'*|*\\*|*'
'*) echo 'Unsupported path for sandbox policy' >&2; exit 1;; esac
scratch=$(mktemp -d /private/tmp/dsh-native-replay.XXXXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 1' HUP INT TERM
mkdir -p "$scratch/tmp"
policy=$scratch/policy.sb
{
  printf '%s\n' '(version 1)' '(allow default)'
  printf '(deny file-read* (subpath "%s"))\n' "$account_dir"
  # Node resolves each ancestor of the repository before it can load scripts.
  ancestor=$root
  while [ "$ancestor" != / ]; do
    printf '(allow file-read-metadata (literal "%s"))\n' "$ancestor"
    ancestor=$(dirname -- "$ancestor")
  done
  printf '(allow file-read-metadata (literal "%s"))\n' "$root/benchmark"
  for code_dir in "$root/lib" "$root/node_modules" "$root/benchmark/harness-e2e"; do
    printf '(allow file-read* (subpath "%s"))\n' "$code_dir"
  done
  printf '(allow file-read* (literal "%s"))\n' "$root/package.json"
  printf '%s\n' '(deny file-write*)' '(allow file-write* (literal "/dev/null"))'
  printf '(allow file-write* (subpath "%s"))\n' "$scratch"
  printf '%s\n' '(deny network-outbound)' '(allow network-outbound (remote ip "localhost:*"))' '(deny network-inbound)' '(allow network-inbound (local ip "localhost:*"))'
} > "$policy"
# The replay supplies a synthetic token and separate DSH_HOME and DSH_AGENTS_HOME.
env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin MEMLAB_DSH_REPLAY_TMP="$scratch/tmp" \
  /usr/bin/sandbox-exec -f "$policy" "$node" "$root/benchmark/harness-e2e/dsh/bounded-contract.cjs" "$cli"
