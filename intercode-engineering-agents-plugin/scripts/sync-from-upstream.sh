#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="https://raw.githubusercontent.com/corbitsdev/examples/main/solutions/engineering-agent-team"
AGENTS="$ROOT/engineering-agents/agents"
SKILLS="$ROOT/engineering-agents/skills"

mkdir -p "$AGENTS"
for f in greybeard critique intern neckbeard karen; do
  curl -sL "$BASE/agents/${f}.md" -o "$AGENTS/${f}.md"
done

for s in style philosophy interview dispatch; do
  mkdir -p "$SKILLS/$s"
  curl -sL "$BASE/skills/$s/SKILL.md" -o "$SKILLS/$s/SKILL.md"
done

echo "Synced agents/ and skills/ from engineering-agent-team into $ROOT/engineering-agents"