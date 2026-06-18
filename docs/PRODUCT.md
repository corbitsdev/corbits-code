# Intercode — Product

## What It Is

A single-process coding agent CLI that autonomously implements features in a codebase. It reads files, writes code, runs tests, and submits work — driven by a deterministic event loop rather than a chat transcript. The agent is backed by an OpenAI-compatible LLM and built on Interchange primitives. It runs as a full-screen terminal UI by default, or headless for scripts and CI.

## Why It Exists

Existing coding agents stall. They get stuck in thinking loops, read files endlessly without writing, drift from their own plans, or forget to signal completion. The user watches a "Thinking..." spinner and hopes. This tool replaces the chat interface with a deterministic event loop that enforces progress and makes every action — and its cost — visible.

## Target Users

- Developers who want to delegate discrete feature implementations to an agent
- Teams who need reproducible, autonomous coding tasks with verifiable output
- Users who want visibility into agent progress, cost, and safety — not a black box

## Key Value Propositions

1. **Deterministic progress** — Every turn must produce a tool call. No idle thinking; the director aborts a stalled run rather than spinning.
2. **Plan as contract** — The agent declares a structured plan on turn 1 and the system enforces that `submit_output` cannot fire without one.
3. **Stall detection** — The director detects idle cycles and intervenes.
4. **Safe by default** — Consequential actions (writes, edits, shell) pass a permission gate; secret files and catastrophic commands are denied outright, regardless of intent.
5. **Resume capability** — Runs persist to a git-backed store and resume from the last point after interruption.
6. **Post-submit critique** — Build, type-check, and tests run before a result is accepted.
7. **Legible loop** — A live event log, working-tree diff panel, plan tracker, and real-time cost meter show what happened, when, and why.
8. **Operator-in-the-loop** — The agent can call `ask_operator` to pause and ask a clarifying question; the operator answers from a modal (TUI) or stdin (headless).
9. **Mid-run steering** — Two modes while the agent is running: **Enter** interrupts the current run immediately and starts a new turn with your message; **Alt+Enter** queues the message for delivery at the next turn boundary without stopping the current run. A badge on the input shows the count of queued messages. A hint line in the input area makes both options discoverable.

## User Experience

### TUI Mode (default)

```bash
$ intercode "Add JWT auth to the API"
```

A full-screen terminal interface: a pinned header (status, turns, live cost), a scrollable event log, a context panel that toggles between the working-tree diff and the plan, modals for permission prompts and operator questions, and a chat input for follow-up turns.

### Headless Mode

```bash
$ intercode --headless "Add JWT auth to the API"
```

Streams the event log to stderr for scripts and CI. Non-interactive: any action that would need operator approval is denied unless `--dangerously-skip-permissions` is set.

### Resume

```bash
$ intercode resume
```

Continues from the last saved state in the working directory.

## Safety Model

- **Tiered permission gate** — Read-only tools (`read_file`, `search_files`, `grep`, `list_dir`) run freely. Every consequential tool (`write_file`, `edit_file`, `run_shell`, …) is gated. The operator can Allow Once or Allow Always (scoped to a file, a directory, or a command shape); "Allow Always" choices persist per working directory so repeat actions don't interrupt flow.
- **Secret guard (hard deny)** — Sensitive files (`.env`, `id_rsa`, `*.pem`, `.aws/credentials`, `.ssh/*`, `.git-credentials`, and similar) can never be read or written by the agent, even with approval. Template files like `.env.example` are exempt.
- **Catastrophic-command deny** — Destructive shell patterns (`rm -rf`, `mkfs`, `dd`, `sudo`, fork bombs, `curl | bash`, force-push, …) are blocked before they run.
- **Constrained auto mode** — Auto mode runs without per-action prompts, but it is not a free-for-all. The agent cannot create or edit files through ad-hoc shell tooling (output redirection, `tee`, `sed -i`, python/node one-liners) — those are denied so every change flows through the reviewable `write_file`/`edit_file` path. Dependency installs (npm/pip/cargo/brew, `npx`/`bunx`, …) still require explicit operator approval and never run unattended, because they fetch and execute untrusted code.
- **Path sandboxing** — Tool path arguments are resolved against the working directory; paths that escape it are blocked.
- **Write verification** — After every write/edit the file is re-read and compared to confirm the change actually landed.

## Slash Commands (TUI)

The TUI has an extensible slash-command framework. Built-ins include `/help` (shortcut + command overlay), `/model` (open the agent configuration surface), `/permissions`, `/workflows`, `/clear`, `/new`, and `/mcp`. Plugins can register additional commands.

`/agent` opens a dedicated full-screen modal — the single place agent configuration lives. Today it holds a Provider / Model section: it lists configured providers, marks the active one, and lets you switch provider and model. A switch applies to the running session immediately (no restart), and can be saved as this project's default (written to the per-repo selection file). The surface is section-based so future configuration (system-prompt overrides, profiles) lands as additional sections rather than new slash commands.

## Lifecycle Hooks

Config-driven `postTurn` and `postRun` hooks (TypeScript or shell) run automatically, discovered from `.intercode/hooks` (per-repo) and `~/.intercode/hooks` (global). `postTurn` receives aggregated turn context (tool calls, results, token usage, duration); `postRun` receives a run summary. The TUI hook panel lists discovered hooks and lets the user enable/disable them. See `docs/HOOKS.md`.

## Failure Modes and Recovery

### Stall (idle cycles)

**What the user sees:** The agent stops producing tool calls. After 3 idle turns the run aborts with `Agent stalled: no tool calls for 3 turns.`

**Recovery:** State is saved; inspect `.agent-state/run.json`, adjust the task or prompt, and start a new run.

### Permission denied (headless)

**What the user sees:** In a non-interactive run, a consequential action that needs approval returns a tool error explaining that approval is unavailable.

**Recovery:** Re-run interactively (TUI), pre-approve via persisted approvals, narrow the action, or re-run with `--dangerously-skip-permissions`.

### Critique failure

**What the user sees:** The agent calls `submit_output` but the post-submit critique fails (build, type, or test error). The run ends `failed` with the critique error.

**Recovery:** State is preserved; inspect the error, fix the issue, or start a new, more specific run.

### Resume after interruption

**What the user sees:** `Ctrl+C` mid-run, network error, or crash. The last state is persisted.

**Recovery:** `intercode resume` reloads `RunState` + `DirectorPersistedState` and continues.

## Configuration

Providers and models are configured in `~/.intercode/settings.json` (holds providers + credentials), with a selection-only per-repo `.intercode/settings.json` override. Select at launch with `--provider` / `--model`, or point at an alternate file with `--config <path>`. Credentials are read only from these settings files — there is no environment-variable override and `.env` files are not loaded, so a stale or exported key can't shadow the configured provider. The agent is denied read access to both settings files.

## Roadmap (planned, not yet shipped)

- **Fast provider/model switching** in the TUI with a persisted default (CL-1221).
- **Perpetual-session context management** — compaction/curation so a long-running session's context window stays bounded (CL-930).

## Business Justification

- Raw feature throughput: the agent completes tasks without human babysitting.
- Cost transparency: every turn's token usage is tracked and visible live.
- Trust: secrets and catastrophic actions are unreachable; consequential actions are gated and auditable.
- Verifiable output: only builds that pass type-check and tests are accepted.
