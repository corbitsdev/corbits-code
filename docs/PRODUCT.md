# Corbits Code — Product

## What It Is

A single-process coding agent CLI that autonomously implements features in a codebase. It reads files, writes code, runs tests, and submits work — driven by a deterministic event loop rather than a chat transcript. The agent is backed by an OpenAI-compatible LLM and built on Interchange primitives. It runs as a full-screen terminal UI by default, or as a non-TUI `exec` path for scripts and CI.

## Why It Exists

Existing coding agents stall. They get stuck in thinking loops, read files endlessly without writing, drift from their own plans, or forget to signal completion. The user watches a "Thinking..." spinner and hopes. This tool replaces the chat interface with a deterministic event loop that enforces progress and makes every action — and its cost — visible.

## Target Users

- Developers who want to delegate discrete feature implementations to an agent
- Teams who need reproducible, autonomous coding tasks with verifiable output
- Users who want visibility into agent progress, cost, and safety — not a black box

## Key Value Propositions

1. **Deterministic progress** — Every turn must produce a tool call. No idle thinking; the director aborts a stalled run rather than spinning.
2. **Task tracking** — The agent can maintain a `manage_tasks` checklist for multi-step work; non-interactive `submit_output` is blocked while checklist items remain open. (A "task" here is a work item, not a child agent — spawning uses the separate `task` tool / sub-agent surface.)
3. **Stall detection** — The director detects idle cycles and intervenes.
4. **Safe by default** — Consequential actions (writes, edits, shell) pass a permission gate; secret files and catastrophic commands are denied outright, regardless of intent.
5. **Resume capability** — Runs persist to a git-backed store and resume from the last point after interruption.
6. **Legible loop** — A live event log, working-tree diff panel, plan tracker, and real-time cost meter show what happened, when, and why.
7. **Operator-in-the-loop** — The agent can call `ask_operator` to pause and ask a clarifying question; the operator answers from a modal (TUI) or via stdin when the product agent runs under `corbits exec`.
8. **Mid-run steering** — Two modes while the agent is running: **Enter** interrupts the current run immediately and starts a new turn with your message; **Alt+Enter** queues the message for delivery at the next turn boundary without stopping the current run. A badge on the input shows the count of queued messages. A hint line in the input area makes both options discoverable.
9. **Session mode (TUI)** — **Single-agent** keeps one primary loop on the wire (no `task` / `search_agents` tools). **Orchestrator** is for chatting with the top agent while it delegates via `task` and manages parallel sub-agents. On first launch, Corbits Code asks once; **Enter** saves to global settings (highlight defaults to single-agent; **Ctrl+C** skips save, runs orchestrator this session only, and the prompt returns on later launches until you save). **Settings → Session** can change global or per-repo defaults, but mode takes effect on the **next** session start (unlike `/agent` provider switches). The `exec` path uses the same `sessionMode` resolution as the TUI (global + per-repo settings; defaults to orchestrator when unset).

## User Experience

### TUI Mode (default)

```bash
$ corbits "Add JWT auth to the API"
```

A full-screen terminal interface: a pinned header (session title and workflow progress), a scrollable event log, modals for permission prompts and operator questions, and a chat input for follow-up turns.

### Exec mode (non-TUI product path)

```bash
$ corbits exec "Add JWT auth to the API"
# alias:
$ corbits run "Add JWT auth to the API"
```

Same directors, tools, permissions, MCP, plugins, and hooks as the TUI — without the Ink shell. The exec bootstrap is a deliberate fork of the TUI path (not a shared factory yet); see `docs/ARCHITECTURE.md` “Exec Runner” for intentional deltas (no workflow controller; single primary send). Streams assistant text to stdout for scripts and CI. Non-interactive by default: actions that need operator approval are denied unless `--dangerously-skip-permissions` is set (or auto mode covers them). `ask_operator` reads a single line from stdin when available.

Local multi-model capability checks use this path (`bun run eval:capability`); see `evals/capability/README.md`.

### Resume

```bash
$ corbits resume
```

Continues from the last saved state in the working directory.

## Safety Model

- **Tiered permission gate** — Read-only tools (`read_file`, `search_files`, `grep`, `list_dir`) run freely. Every consequential tool (`write_file`, `edit_file`, `run_shell`, …) is gated. The operator can Allow Once or Allow Always (scoped to a file, a directory, or a command shape); "Allow Always" choices persist per working directory so repeat actions don't interrupt flow.
- **Secret guard** — Path-keyed tools (`read_file`, `write_file`, …) hard-deny sensitive files (`.env`, `id_rsa`, `*.pem`, `.aws/credentials`, `.ssh/*`, `.git-credentials`, and similar), even with approval or `--dangerously-skip-permissions`. Template files like `.env.example` are exempt. Shell commands that *reference* those paths (e.g. `bun --env-file=.env.staging run …`, `cat .env`) require explicit operator approval and never auto-run in auto mode; once approved, they proceed. Tool-result scrubbing still redacts credential-shaped output that reaches the transcript.
- **Catastrophic-command deny** — Destructive shell patterns that target system roots (`rm -rf /`, home, `/etc`, …), plus `mkfs`, `dd`, `sudo`, fork bombs, `curl | bash`, force-push, … are blocked before they run. Recursive delete of ordinary workspace paths is not hard-denied but requires operator approval (never auto in auto mode).
- **Constrained auto mode** — Default is on (`auto = true`). Pass `--no-auto` to start in ask mode, or press **SHIFT+TAB** in the TUI to toggle (enabling prints a one-line envelope reminder). Auto mode auto-approves workspace file writes/edits/deletes and unconstrained shell without per-action prompts, but it is not a free-for-all:
  - **Denied** (must use `write_file` / `edit_file`): shell file mutations via output redirection, `tee`, `sed -i` / `perl -i`, interpreter inline programs or heredocs.
  - **Still asks**: dependency installs and remote runners (npm/yarn/pnpm/bun, pip, cargo, go, brew, `npx`/`bunx`, …), recursive `rm`, git worktree add/remove/prune (list is fine), shell that references sensitive paths, and opaque unparseable wrappers (variable expansion or command substitution).
  - **Wrapper peel**: `bash`/`sh`/`zsh -c`, `xargs`, and transparent prefixes (`env`, `nice`, `timeout`, …) are expanded so the same deny/ask rules see the inner payload.
  - Paths outside the workspace and writes under `.agent-state` still ask; mutating MCP and unknown tools still prompt.
- **Path sandboxing** — Tool path arguments are resolved against the working directory; paths that escape it are blocked.
- **Write verification** — After every write/edit the file is re-read and compared to confirm the change actually landed.

## Slash Commands (TUI)

The TUI has an extensible slash-command framework. Built-ins include `/help` (shortcut + command overlay), `/model` (open the agent configuration surface), `/settings`, `/permissions`, `/plugins`, `/login`, `/clear`, `/new`, `/mcp`, and `/goal` (session goal: expand a brief into an acceptance checklist and auto-continue until every criterion is done — see `/goal [turns] <brief>`, `/goal pause|resume|clear|status`, optional `--tokens N` / `--replace`), plus a `/<name>` command per available workflow. Plugins can register additional commands.

`/goal <brief>` arms a session-scoped goal governor. The operator brief is **not** the completion condition: the agent must clarify success (via `ask_operator` when vague) and expand it into a multi-item **acceptance** checklist with `manage_goal` *before* substantial work. Work steps go in `manage_tasks` (shown as **Work** while a goal is active) — separate from acceptance. Lifecycle phases surface in the UI: **planning** (define Acceptance) → **implementing** (Work primary; Acceptance compact; `doing` on a criterion stays here) → **reviewing** (starts when any criterion is `done` or `blocked`) → **completed** (all non-cancelled criteria done; auto-achieves). After each clean yield the agent is re-inferred until every acceptance criterion is done, a finite turn/token budget soft-stops, or the operator pauses/clears. **Default turn budget is unlimited** (`0`); an optional leading integer caps continues (`/goal 40 ship the feature`). Resume restores a prior goal as **paused** (never silently re-armed); unlimited goals stay unlimited on resume, finite ones get headroom. While a goal is **active**, permission prompts that still need a human answer auto-skip after ~15s with a note back to the agent (human may be away — continue another way); the operator can still approve/deny earlier. Pair with auto mode and/or `--dangerously-skip-permissions` for longer unattended runs. Goal mode does not shrink tools, skills, slash commands, sub-agents, or MCP.




`/agent` opens a dedicated full-screen modal — the single place agent configuration lives. Today it holds a Provider / Model section: it lists configured providers, marks the active one, and lets you switch provider and model. A switch applies to the running session immediately (no restart), and can be saved as this project's default (written to the per-repo selection file). The surface is section-based so future configuration (system-prompt overrides, profiles) lands as additional sections rather than new slash commands.

## Lifecycle Hooks

Config-driven `postTurn` and `postRun` hooks (TypeScript or shell) run automatically, discovered from `.corbits/hooks` (per-repo) and `~/.corbits/hooks` (global). `postTurn` receives aggregated turn context (tool calls, results, token usage, duration); `postRun` receives a run summary. The TUI hook panel lists discovered hooks and lets the user enable/disable them. See `docs/HOOKS.md`.

## Failure Modes and Recovery

### Stall (idle cycles)

**What the user sees:** The agent stops producing tool calls. After 3 idle turns the run aborts with `Agent stalled: no tool calls for 3 turns.`

**Recovery:** State is saved; inspect `.agent-state/run.json`, adjust the task or prompt, and start a new run.

### Permission denied (exec)

**What the user sees:** In a non-interactive `corbits exec` run, a consequential action that needs approval returns a tool error explaining that approval is unavailable.

**Recovery:** Re-run interactively (TUI), pre-approve via persisted approvals, narrow the action, or re-run with `--dangerously-skip-permissions`.

### Resume after interruption

**What the user sees:** `Ctrl+C` mid-run, network error, or crash. The last state is persisted.

**Recovery:** `corbits resume` reloads `RunState` and continues.

## Configuration

Providers and models are configured in `~/.corbits/settings.json` (holds providers + credentials), with a selection-only per-repo `.corbits/settings.json` override. Select at launch with `--provider` / `--model`, or point at an alternate file with `--config <path>`. Credentials are read only from these settings files — there is no environment-variable override and `.env` files are not loaded, so a stale or exported key can't shadow the configured provider. The agent is denied read access to both settings files.

## Optional Capabilities (plugins)

Capabilities beyond the core toolset are opt-in plugins, enabled per workspace through the `/plugins` UI — nothing is wired in until enabled.

- **Web search and fetch** — `web_search`/`web_fetch` are provided by an optional web plugin (e.g. Exa). There is no built-in web access: with no web plugin enabled the tools are simply absent (so they are not advertised in the base prompt), and network egress lives in the external provider rather than the agent's own process.

## Multi-agent (sub-agents)

In the TUI, sub-agents are available when **session mode** is **orchestrator** (see value prop #9); **single-agent** mode removes the `task` and `search_agents` tools from the primary session.

Corbits Code can fan work out to short-lived **sub-agents** — child agents with their own loop, tools, and checklist — while the primary session stays focused.

- **Agents** are runtime entities (primary session or child).
- **Tasks** are checklist items owned by one agent via `manage_tasks`.
- **Sub-agents** are spawned with the `task` tool (wire name kept; meaning is "spawn a child agent," not "add a checklist item").

Dispatch uses a structured brief (context / goal / optional goals seed) and returns a structured report. The TUI Agents strip shows who is running; live tool progress updates the status bar without dumping the child transcript into the parent chat. Leaf workers hard-stop after 2 consecutive identical tool calls, when their inference-turn budget is exhausted (default 30; parent can pass `maxTurns` per dispatch; profiles and global settings can raise the default; cap 100), or when they finish without ever using tools (never-acted salvage — planning/prose only is not a successful implement). Each hard stop returns a salvage report so a runaway or idle child cannot quietly burn a large token budget or look done after prose alone. The orchestrator can re-dispatch with continuation context and a higher `maxTurns` when useful.

## Roadmap (planned, not yet shipped)

- **Fast provider/model switching** in the TUI with a persisted default.
- **Perpetual-session context management** — compaction/curation so a long-running session's context window stays bounded.

## Business Justification

- Raw feature throughput: the agent completes tasks without human babysitting.
- Cost transparency: every turn's token usage is tracked and visible live.
- Trust: secrets and catastrophic actions are unreachable; consequential actions are gated and auditable.
- Verifiable output: only builds that pass type-check and tests are accepted.
