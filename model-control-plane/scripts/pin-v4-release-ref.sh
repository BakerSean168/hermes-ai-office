#!/usr/bin/env bash
set -euo pipefail

canonical_root="${PIXEL_V4_CANONICAL_ROOT:-/home/dev/projects/pixel-agents}"
release_ref="${PIXEL_V4_RELEASE_REF:-refs/pixel-v4/release-approved}"
release_lock="${PIXEL_V4_RELEASE_LOCK:-/tmp/hermes-pixel-v4-release.lock}"
candidate="${1:-}"

if [[ -z "$candidate" ]]; then
  echo "usage: $0 <exact-commit-sha>" >&2
  exit 2
fi
if [[ "$release_ref" != refs/pixel-v4/* ]]; then
  echo "refusing release ref outside refs/pixel-v4" >&2
  exit 1
fi
exec 9>"$release_lock"
flock -n 9 || { echo "refusing release approval: a V4 release is active" >&2; exit 1; }

git -C "$canonical_root" cat-file -e "${candidate}^{commit}"
sha="$(git -C "$canonical_root" rev-parse "${candidate}^{commit}")"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing invalid release commit" >&2
  exit 1
fi

# Release approval is an explicit operator/controller action performed only
# after the required review/quality gates. This script pins provenance; it does
# not invent or claim review evidence itself.
git -C "$canonical_root" config core.fsync committed
old="$(git -C "$canonical_root" rev-parse --verify "$release_ref" 2>/dev/null || true)"
if [[ -n "$old" ]]; then
  git -C "$canonical_root" merge-base --is-ancestor "$old" "$sha" || {
    echo "refusing non-fast-forward release ref update: $old -> $sha" >&2
    exit 1
  }
  git -C "$canonical_root" update-ref --create-reflog -m "pixel-v4 release approval $sha" "$release_ref" "$sha" "$old"
else
  git -C "$canonical_root" update-ref --create-reflog -m "pixel-v4 release approval $sha" "$release_ref" "$sha"
fi

resolved="$(git -C "$canonical_root" rev-parse "${release_ref}^{commit}")"
[[ "$resolved" == "$sha" ]] || { echo "release ref verification failed" >&2; exit 1; }
printf 'release_ref=%s\nsource_sha=%s\n' "$release_ref" "$sha"
