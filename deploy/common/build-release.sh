#!/usr/bin/env bash
# Run on the OPERATOR's machine (not on a server): packs the committed tree at HEAD (no working-tree
# changes, no untracked files, no node_modules) and prints its sha256. Send the sha256 to the server
# operator over a second channel; `deploy.sh release <tar> <sha256>` refuses a mismatch.
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ -n "$(git status --porcelain)" ]]; then echo "working tree not clean — commit first" >&2; exit 1; fi
commit="$(git rev-parse --short=12 HEAD)"
out="${1:-.}/savebridge-${commit}.tar.gz"
git archive --format=tar.gz --prefix="savebridge-${commit}/" -o "$out" HEAD
if command -v sha256sum >/dev/null; then sha="$(sha256sum "$out" | awk '{print $1}')"; else sha="$(shasum -a 256 "$out" | awk '{print $1}')"; fi
echo "release: $out"
echo "commit:  $(git rev-parse HEAD)"
echo "sha256:  $sha"
