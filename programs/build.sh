#!/usr/bin/env bash
# Builds the example application programs into programs/build/.
# Requires the Solana SBF toolchain: cargo-build-sbf (ships with the Solana CLI).
#
# Pass --if-available to skip silently when the toolchain is absent. The test suite uses that
# form so editing a program and running `npm test` cannot silently verify a stale binary, while
# contributors without the Rust toolchain can still run the TypeScript tests.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$root/build"
mkdir -p "$out"

if ! command -v cargo-build-sbf >/dev/null 2>&1; then
  if [ "${1:-}" = "--if-available" ]; then
    echo "cargo-build-sbf not found; keeping existing artifacts in programs/build/."
    echo "Program tests will be skipped if no artifact is present."
    exit 0
  fi
  echo "cargo-build-sbf not found. Install the Solana CLI:" >&2
  echo '  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"' >&2
  exit 1
fi

for manifest in "$root"/*/Cargo.toml; do
  crate="$(dirname "$manifest")"
  name="$(basename "$crate")"
  printf 'Building %s\n' "$name"
  (cd "$crate" && cargo-build-sbf --sbf-out-dir "$out" >/dev/null)
done

printf '\nArtifacts in %s:\n' "$out"
for so in "$out"/*.so; do
  printf '  %s  %s\n' "$(sha256sum "$so" | cut -c1-16)" "$(basename "$so")"
done
