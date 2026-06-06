---
name: feedback-no-sed
description: Never use sed to read or write files — use Read/Edit/Write tools instead
metadata:
  type: feedback
---

Never use sed (or awk/echo/cat) for reading or writing file content. Always use the native Read, Edit, and Write tools.

**Why:** User explicitly rejected a sed-based file edit and stated this is a hard rule.

**How to apply:** Any time you need to read file contents or make edits, use Read/Edit/Write tools. Reserve Bash for shell-only operations (running commands, checking processes, git operations, etc.).
