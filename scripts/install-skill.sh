#!/usr/bin/env bash
# Copies the project-local Claude Code skill to the user's global skill
# directory, so it's loaded in *any* project (not just this repo).
#
# Usage:  bash scripts/install-skill.sh
#         OR via npm:  npm run install:skill
#
# Idempotent — re-runs overwrite the existing global file.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_DIR/.claude/skills/agentic-rc/SKILL.md"
DST_DIR="$HOME/.claude/skills/agentic-rc"
DST="$DST_DIR/SKILL.md"

if [[ ! -f "$SRC" ]]; then
  echo "✗ source file not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DST_DIR"
/bin/cp "$SRC" "$DST"
echo "✓ installed agentic-rc skill to $DST"
echo "  (was: $SRC)"
echo
echo "Restart Claude Code to pick it up globally — or just keep working in"
echo "this repo, where the project-local copy is auto-loaded."
