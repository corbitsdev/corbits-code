# Corbits Code — Product

## What It Is

A single-process coding agent CLI that autonomously implements features in a codebase. It reads files, writes code, runs tests, and submits work — driven by a deterministic event loop rather than a chat transcript. The agent is backed by an OpenAI-compatible LLM and built on Interchange primitives. It runs as a full-screen terminal UI by default, or as a non-TUI `exec` path for scripts and CI.

## Why It Exists

Existing coding agents stall. They get stuck in thinking loops, read files endlessly without writing, drift from their own plans, or forget to signal completion. The user watches a "Thinking..." spinner and hopes. This tool replaces the chat interface with a deterministic event loop that enforces progress and makes every action — and its cost — visible.

## The Harness Is the Product

Corbits Code is a **local agentic software factory**, and the thing being built is the harness: the loop that dispatches work, watches it, decides what happens next, and reports to the operator. Everything else is content that runs inside it.

That distinction sets priority.

**The harness is core and cannot be swapped in later**, because everything runs inside it. Fleet events waking the director, continuous dispatch while capacity is free, unprompted reporting, aggregated health, a bound grounded in real cost rather than a turn count. This is the part no one can hand us and the part a competitor cannot copy from a directory of prompts.

**Agent personas and skills are content.** They define who gets dispatched and to what standard. They are valuable, they are swappable, and they can ship as a directory long before any packaging system exists. The default engineering set is built in and always enabled — not an optional install, not something an operator has to discover.

**Distribution is packaging for content**, and content is not the constraint. A catalog and an install surface matter eventually; they do not gate anything the product is actually judged on.

The evidence is in how the product fails today: the personas already produce excellent work — reviewers catch real defects, refuse unsafe operations, and correct their own briefs — while the loop around them goes quiet with capacity free, forcing the operator to interrupt and ask whether anything is alive. The content is not the weak part.

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
8. **Mid-run steering** — Two modes while the agent is running: **Enter** queues the message for delivery at the next turn boundary without stopping the current run; **Alt+Enter** steers by interrupting the current run immediately and starting a new turn with your message. **Ctrl+C** stops the run outright. A badge on the input shows the count of queued messages. A hint line in the input area (`Enter queue · Alt+Enter steer · Ctrl+C stop`) makes the options discoverable.
9. **Session mode (TUI)** — **Single-agent** keeps one primary loop on the wire (no `task` / `search_agents` tools). **Orchestrator** is for chatting with the top agent while it delegates via `task` and manages parallel sub-agents. On first launch, Corbits Code asks once; **Enter** saves to global settings (highlight defaults to single-agent; **Ctrl+C** skips save, runs orchestrator this session only, and the prompt returns on later launches until you save). **Settings → Session** can change global or per-repo defaults, but mode takes effect on the **next** session start (unlike `/model` provider switches). The `exec` path uses the same `sessionMode` resolution as the TUI (global + per-repo settings; defaults to orchestrator when unset).

## User Experience

### TUI Mode (default)

```bash
$ corbits "Add JWT auth to the API"
```

A full-screen terminal interface: a pinned header (session title and workflow progress), a scrollable event log, modals for permission prompts and operator questions, and a chat input for follow-up turns.

**Behavior spec** (OpenTUI is the shipping shell): `docs/TUI.md` — layout,
chrome budget, overlays, selectors, the `/` command list, prompt box, and
scroll/mouse behavior.

### Exec mode (non-TUI product path)

```bash
$ corbits exec "Add JWT auth to the API"
# alias:
$ corbits run "Add JWT auth to the API"
```

Same directors, tools, permissions, MCP, plugins, and hooks as the TUI — without the OpenTUI shell. The exec bootstrap is a deliberate fork of the TUI path (not a shared factory yet); see `docs/ARCHITECTURE.md` “Exec Runner” for intentional deltas (no workflow controller; single primary send; non-interactive permission gate). Compaction continuation matches TUI so long runs do not stall after compact. Streams assistant text to stdout for scripts and CI. Non-interactive by default: actions that need operator approval are denied unless `--dangerously-skip-permissions` is set (or auto mode covers them). `ask_operator` reads a single line from stdin when available.

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
- **Constrained auto mode** — Default is on (`auto = true`). Pass `--no-auto` to start in ask mode, or `--auto` to force it on; there is currently no in-session key to toggle it. Auto mode auto-approves workspace file writes/edits/deletes and unconstrained shell without per-action prompts, but it is not a free-for-all:
  - **Denied** (must use `write_file` / `edit_file`): shell file mutations via output redirection, `tee`, `sed -i` / `perl -i`, interpreter inline programs or heredocs.
  - **Still asks**: dependency installs and remote runners (npm/yarn/pnpm/bun, pip, cargo, go, brew, `npx`/`bunx`, …), recursive `rm`, git worktree add/remove/prune (list is fine), shell that references sensitive paths, and opaque unparseable wrappers (variable expansion or command substitution).
  - **Wrapper peel**: `bash`/`sh`/`zsh -c`, `xargs`, and transparent prefixes (`env`, `nice`, `timeout`, …) are expanded so the same deny/ask rules see the inner payload.
  - Paths outside the workspace and writes under the session state root still ask; mutating MCP and unknown tools still prompt.

- **Path sandboxing** — Tool path arguments are resolved against the working directory; paths that escape it are blocked.
- **Write verification** — After every write/edit the file is re-read and compared to confirm the change actually landed.

## Slash Commands (TUI)

The TUI has an extensible slash-command framework. Built-ins include `/help` (shortcut + command overlay), `/model` (models-only picker for connected accounts; **Alt+A** adds a provider), `/settings`, `/permissions`, `/plugins`, `/clear`, `/new`, and `/mcp`, plus a `/<name>` command per available workflow. Plugins can register additional commands.

Providers are **models-first**: there is no standalone `/login` command. `/model` opens a **models-only list** (Recent, Favorites, then connected provider/model rows) — type-to-filter owns printable keys, so Connect is never a bare letter. **Alt+A** opens a dedicated add-provider selector over every first-class kind (OpenAI dual-path ChatGPT OAuth or API key, xAI, OpenCode Zen, Anthropic, Google, OpenCode Go, Z.AI Coding Plan, Custom), each annotated with its live account count and never filtered out for “already connected.” **Alt+F** toggles favorite on the highlighted model. Advanced provider drill-down (edit/delete/tiers) stays on the advanced surface, not a bare printable key while the model list is filtering. OAuth providers open their existing browser login with a named account step so multiple accounts per kind coexist (`codex/work`, …). API-key providers use the same named-instance step before the key (auth-only form: instance name + key + fixed catalog base URL), so personal and team keys land as distinct catalog rows (`openai/default`, `anthropic/work`, …); reusing a name re-keys that instance after confirm. Custom remains a free-form single endpoint (full manual form). Successful connect refreshes the catalog and reopens the model list focused on the new account’s default model. OpenCode Go routes each model by its protocol metadata (chat completions, OpenAI responses, or Anthropic messages) and can show subscription usage in the status bar when active (rolling 5h / weekly / monthly windows when the usage API responds; omitted on auth or network failure). When Go returns a quota or rate-limit error — including some HTTP 400 responses that carry limit payloads — Corbits classifies them so quota aborts cleanly and short provider rate limits remain retryable. On a free-tier or subscription quota hit, wait for the window to reset or use OpenCode Zen free models.

`/model` opens a dedicated full-screen modal — the single place agent configuration lives. The default view is models-only (Recent / Favorites / connected models); add-provider, tiers, and profiles remain reachable from the same surface without in-list “connect →” rows. A switch applies to the running session immediately (no restart), and can be saved as this project's default (written to the per-repo selection file). Recent and favorite model pairs are stored in global settings (no credentials).

## Lifecycle Hooks

Config-driven `postTurn` and `postRun` hooks (TypeScript or shell) run automatically, discovered from `.corbits/hooks` (per-repo) and `~/.corbits/hooks` (global). `postTurn` receives aggregated turn context (tool calls, results, token usage, duration); `postRun` receives a run summary. The TUI hook panel lists discovered hooks and lets the user enable/disable them. See `docs/HOOKS.md`.

## Failure Modes and Recovery

### Stall (tool-only turns with no narration)

**What the user sees:** The agent runs several turns in a row that are all tool calls with no explanation of what it's doing. After a one-shot nudge to explain itself, if the pattern continues the session **auto-pauses**: it stops issuing new inferences and replies with "Auto-paused: the model ran N steps in a row without explaining its progress. Send a message to resume." The session is not aborted — sending any message resumes it.

The exact turn thresholds are model-family-dependent (tighter for models with observed runaway tool-only behavior); see "Main-session loop protection" in `docs/ARCHITECTURE.md`.

**Recovery:** Send a message to resume. To inspect state first, see `~/.corbits/projects/<project-key>/<session-id>/run.json` (or a legacy in-repo `.agent-state/` tree if not yet migrated).


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

- **Web search and fetch** — `web_search`/`web_fetch` are always-on built-in core tools, no plugin or API key required. `web_fetch` runs in-process (Bun native `fetch()`) with SSRF guarding, a 5 MB response cap, and HTML-to-markdown conversion; `web_search` calls a keyless hosted MCP provider (Exa by default, Parallel optional). See `docs/ARCHITECTURE.md` for details.

## Multi-agent (sub-agents)

In the TUI, sub-agents are available when **session mode** is **orchestrator** (see value prop #9); **single-agent** mode removes the `task` and `search_agents` tools from the primary session.

Corbits Code can fan work out to short-lived **sub-agents** — child agents with their own loop, tools, and checklist — while the primary session stays focused.

- **Agents** are runtime entities (primary session or child).
- **Tasks** are checklist items owned by one agent via `manage_tasks`.
- **Sub-agents** are spawned with the `task` tool (wire name kept; meaning is "spawn a child agent," not "add a checklist item").

Dispatch uses a structured brief (context / goal / optional goals seed) and returns a structured report. The TUI Agents strip shows who is running; live tool progress updates the status bar without dumping the child transcript into the parent chat. Leaf workers hard-stop after 2 consecutive identical tool calls, when their inference-turn budget is exhausted (default 30; parent can pass `maxTurns` per dispatch; profiles and global settings can raise the default; cap 100), when they finish without ever using tools (never-acted salvage — planning/prose only is not a successful implement), or when `intent=implement` finishes after tools but without any file write/edit/delete (never-edited salvage — a pure-explore plan is not a successful implement). Progressive re-read thrash also hard-stops a leaf that keeps re-reading the same path past a limit; before that hard stop, a soft mid-run nudge asks implement leaves to edit or wrap up (explore leaves: expand findings / change approach — never forced to edit). Each hard stop returns a salvage report so a runaway or idle child cannot quietly burn a large token budget or look done after prose alone.
 The parent tracks same-brief fingerprints for the session (`src/subagent/brief-dispatch.ts`): after thrash / no-progress / repetition / never-acted / never-edited salvage, an identical re-dispatch is refused — change prompt, agent, intent, success_criteria, and/or do_not to unlock a new run (`maxTurns` or tier alone does not). Turn-budget salvage still allows a few same-brief retries with a higher `maxTurns`, then flips the parent hint to stop and change approach; a successful complete resets the same-brief retry budget.

## Roadmap (planned, not yet shipped)

- **Fast provider/model switching** in the TUI with a persisted default.
- **Perpetual-session context management** — compaction/curation so a long-running session's context window stays bounded.

## Business Justification

- Raw feature throughput: the agent completes tasks without human babysitting.
- Cost transparency: every turn's token usage is tracked and visible live.
- Trust: secrets and catastrophic actions are unreachable; consequential actions are gated and auditable.
- Verifiable output: only builds that pass type-check and tests are accepted.
