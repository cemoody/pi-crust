#!/usr/bin/env bash
# safe-symlink-node-modules: defensive wrapper for sharing node_modules
# from the canonical worktree into a sibling worktree.
#
# WHY: the naive recipe
#
#     ln -s ../pi-crust/node_modules node_modules
#
# is correct in sibling worktrees (e.g. pi-rc-foo/) but cyclic when run
# from inside the canonical worktree itself — the relative target
# `../pi-crust/node_modules` resolves to the SAME directory, creating a
# self-loop. Every binary lookup under node_modules then hits ELOOP,
# which has taken down our dev api at least four times in 24 h.
#
# This wrapper refuses any of:
#
#   * being run from inside the canonical worktree (presence of the
#     `node_modules/.pi-canonical` sentinel — written by the prepare
#     script in package.json);
#   * resolving the target to the same path as the symlink we'd create
#     (catches the cyclic case even when the sentinel is missing);
#   * clobbering an existing real `node_modules` directory.
#
# Usage:
#
#   cd /home/coder/code/pi-rc-some-sibling
#   /path/to/scripts/safe-symlink-node-modules.sh /home/coder/code/pi-crust
#
# Or, with the canonical worktree auto-discovered relative to this script:
#
#   /home/coder/code/pi-crust/scripts/safe-symlink-node-modules.sh
#
# Exit codes:
#   0 — symlink created (or already present and correct)
#   1 — refused (see stderr for reason)
#   2 — invalid usage

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
default_canonical=$(cd "$script_dir/.." && pwd)
canonical=${1:-$default_canonical}
canonical=$(cd "$canonical" 2>/dev/null && pwd) || {
  echo "safe-symlink: canonical worktree not found: ${1:-$default_canonical}" >&2
  exit 2
}

# Where we'd create the symlink.
target_dir=$(pwd)
target=$target_dir/node_modules

# Source: the canonical worktree's node_modules.
source=$canonical/node_modules

# Refusal #1: same directory. The whole point of this guard.
if [[ "$target_dir" == "$canonical" ]]; then
  echo "safe-symlink: REFUSING — \$PWD is the canonical worktree ($canonical)." >&2
  echo "             Run me from a SIBLING worktree, not the canonical one." >&2
  exit 1
fi

# Idempotency / clobber check: must come before the sentinel check below,
# because if $target is already a correct symlink, the sentinel under it
# would be reached transitively and falsely trip Refusal #3.
if [[ -L "$target" ]]; then
  existing=$(readlink "$target")
  if [[ "$existing" == "$source" ]]; then
    echo "safe-symlink: already linked correctly ($target -> $existing)"
    exit 0
  fi
  # A different (potentially broken or cyclic) symlink — surface it and
  # refuse rather than guessing what the user wanted.
  echo "safe-symlink: REFUSING — $target is a symlink to $existing (not $source)." >&2
  echo "             Remove it manually if that's wrong." >&2
  exit 1
fi
if [[ -e "$target" ]]; then
  # Real directory (sentinel check below decides whether it's canonical).
  if [[ -f "$target/.pi-canonical" ]]; then
    echo "safe-symlink: REFUSING — $target already contains a canonical install (sentinel present)." >&2
    echo "             This means $(pwd) appears to be a canonical worktree." >&2
    exit 1
  fi
  echo "safe-symlink: REFUSING — $target already exists as a non-symlink." >&2
  echo "             Looks like a real install; not clobbering." >&2
  exit 1
fi

# Source must actually be a real directory with the sentinel — otherwise
# we'd be pointing at junk.
if [[ ! -d "$source" ]]; then
  echo "safe-symlink: REFUSING — source $source is not a directory." >&2
  exit 1
fi
if [[ ! -f "$source/.pi-canonical" ]]; then
  echo "safe-symlink: WARNING — source $source has no .pi-canonical sentinel." >&2
  echo "             Proceeding, but you should \`npm install\` in $canonical to write it." >&2
fi

ln -s "$source" "$target"
echo "safe-symlink: $target -> $source"
