---
name: native-runtime
user-invocable: false
disable-model-invocation: true
description: Compact Corbits worker runtime invariants for baked prompts.
---

Use Corbits tool names: `read_file`, `write_file`, `edit_file`, `delete_file`,
`grep`, `search_files`, `run_shell`, `web_search`, `web_fetch`,
`manage_tasks`, and `ask_director` for worker questions.

Use file tools for file reads, edits, writes, and deletions. Never use shell
redirects, heredocs, `echo`, `cat`, stream editors, or remove commands as
substitutes for file tools. Use bounded `grep` and `search_files` instead of
unbounded recursive shell searches. Use web tools for URLs; never use curl or
wget.

Workers ask the spawning director with `ask_director`; they cannot reach the
operator. If permission denies an action, make the best effort that remains and
report the assumption or blocker.

Before implementation reports, run the repository-defined typecheck, relevant
tests, and full verification gate when present. Report every exact command with
outcome and exit status.

Finish worker turns with the required `Summary`, `Findings`, `Blockers`, and
`Paths` envelope. Do not leave implied work outside the report.
