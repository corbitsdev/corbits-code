# Corbits Code — Product

## What It Is

Corbits is a local coding harness: it runs multi-agent fleets that implement,
verify, and land software — with progress and cost always visible to the
operator.

A single-process coding agent CLI that autonomously implements features in a codebase. It reads files, writes code, runs tests, and submits work — driven by a deterministic event loop rather than a chat transcript. The agent is backed by an OpenAI-compatible LLM and built on Interchange primitives. It runs as a full-screen terminal UI by default, or as a non-TUI `exec` path for scripts and CI.

## Why It Exists

Existing coding agents stall. They get stuck in thinking loops, read files endlessly without writing, drift from their own plans, or forget to signal completion. The user watches a "Thinking..." spinner and hopes. This tool replaces the chat interface with a deterministic event loop that enforces progress and makes every action — and its cost — visible.

## The Harness Is the Product

Corbits Code is a **local agentic software factory**, and the thing being built is the harness: the loop that dispatches work, watches it, decides what happens next, and reports to the operator. Everything else is content that runs inside it.

That distinction sets priority.

**The harness is core and cannot be swapped in later**, because everything runs inside it. Fleet events waking the director, continuous dispatch while capacity is free, unprompted reporting, aggregated health, a bound grounded in real cost rather than a turn count. This is the part no one can hand us and the part a competitor cannot copy from a directory of prompts.

**Agent personas and skills are content.** They define who gets dispatched and to what standard. They are valuable, they are swappable, and they ship as the first-party `corbits-skills` plugin — on by default, disable-able in `/plugins`. The default action set (`/implement`, `/plan`, `/refactor`, `/review`, `/pull-request-review`, `/create-issue`, `/scribe`, `/interview`, `/ast-grep`) is not an optional install and not something an operator has to discover.

**Distribution is packaging for content**, and content is not the constraint. A catalog and an install surface matter eventually; they do not gate anything the product is actually judged on.

The evidence is in how the product fails today: the personas already produce excellent work — reviewers catch real defects, refuse unsafe operations, and correct their own briefs — while the loop around them goes quiet with capacity free, forcing the operator to interrupt and ask whether anything is alive. The content is not the weak part.

## Target Users

- Developers who want to delegate discrete feature implementations to an agent
- Teams who need reproducible, autonomous coding tasks with verifiable output
- Users who want visibility into agent progress, cost, and safety — not a black box

## Key Value Propositions

1. **Deterministic progress** — Every turn must produce a tool call. No idle thinking; the director aborts a stalled run rather than spinning.
2. **Task tracking** — The agent can maintain a `manage_tasks` checklist for multi-step work; non-interactive `submit_output` is blocked while checklist items remain open. (A "task" here is a work item, not a child agent — spawning uses the separate `spawn_agent` / `wait_agents` sub-agent surface.)
3. **Stall detection** — The director detects idle cycles and intervenes.
4. **Safe by default** — Consequential actions (writes, edits, shell) pass a permission gate; secret files and catastrophic commands are denied outright, regardless of intent.
5. **Resume capability** — Runs persist to a git-backed store and resume from the last point after interruption.
6. **Legible loop** — A live event log, working-tree diff panel, plan tracker, and real-time cost meter show what happened, when, and why.
7. **Operator-in-the-loop** — The agent can call `ask_operator` to pause and ask a clarifying question; the operator answers from a modal (TUI) or via stdin when the product agent runs under `corbits exec`.
8. **Mid-run steering** — Two modes while the agent is running, keyed to **whose** idle. **Parent-idle** is when the primary Skywalker turn is not inside an in-flight parent tool; **session-idle** is parent-idle **and** no live fleet lanes. **Enter** soft-steers while the parent is busy — delivers at the next **parent** `tool.boundary` without stopping the current run; a long parent `run_shell` or an awaiting `wait_agents` is parent-busy, so Enter is a queued steer, not a new turn. Idle-with-fleet is shipped: after a non-blocking `spawn_agent` dispatch the parent goes idle while workers keep running, and mid-hold Enter starts a new primary turn instead of queueing a steer. **Alt+Enter** queues a follow-up delivered only on session-idle (`run` goes idle; does not interrupt). Session-idle Alt+Enter is a no-op. **Ctrl+C** stops the run outright. The notice row shows distinct `steer N` / `follow-up M` badges; when steers are pending and a parent tool has been in flight a few seconds, the notice names that command. Shortcuts are listed in `/help` (`Enter` soft-steer · `Alt+Enter` follow-up · `Ctrl+C` stop).
9. **Orchestrator-only (TUI + exec)** — The primary session is always the orchestrator: it can act directly and delegates via `spawn_agent` / `wait_agents` / `search_agents`. Long jobs belong on workers — a parent that runs them itself stays parent-busy and holds Enter steers. Single-agent session mode, the first-run mode picker, and Settings → Session are gone (CL-5814). Legacy `sessionMode` values on disk are ignored.

## User Experience

### TUI Mode (default)

```bash
$ corbits "Add JWT auth to the API"
```

A full-screen terminal interface: a pinned header (session title and workflow progress), a scrollable event log, modals for permission prompts and operator questions, and a chat input for follow-up turns. Press **Shift+Tab** to cycle reasoning effort for the current model; the prompt border shows the active level. Plain **Tab** still toggles focus between the prompt and the transcript.

**Behavior spec** (OpenTUI is the shipping shell): `docs/TUI.md` — layout,
chrome budget, overlays, selectors, the `/` command list, prompt box, and
scroll/mouse behavior.

### Exec mode (non-TUI product path)

```bash
$ corbits exec "Add JWT auth to the API"
# alias:
$ corbits run "Add JWT auth to the API"
```

Same directors, tools, permissions, MCP, plugins, and hooks as the TUI — without the OpenTUI shell. The exec bootstrap is a deliberate fork of the TUI path (not a shared factory yet); see `docs/ARCHITECTURE.md` “Exec Runner” for intentional deltas (no workflow controller; single primary send; non-interactive permission gate). Compaction continuation matches TUI so long runs do not stall after compact. Streams assistant text to stdout for scripts and CI. Non-interactive by default: actions that need operator approval are denied unless `--dangerously-skip-permissions` is set, a persisted `/yolo` default is on, or auto mode covers them. `--dangerously-skip-permissions` still forces this process; secret-guard and authz still apply. `ask_operator` reads a single line from stdin when available.

Local multi-model capability checks use this path (`bun run eval:capability`); see `evals/capability/README.md`.

### Resume

```bash
$ corbits resume
```

Opens a picker of the 10 most recently persisted conversations for this
checkout, including completed ones. Type to filter by name. Plain
`corbits` always starts a fresh conversation; `corbits resume <session-id>`
is the direct, explicit resume path.

A session that ended in `failed` (including one that recorded an `error`
string in `run.json`) is a failed session, not a corrupt one. The default
picker still shows only running and cancelled sessions; pass `--force` to
include failed and done. Passing a corrupt session id prints one short
recovery line instead of dumping the file path and parse details.

## Safety Model

- **Tiered permission gate** — Read-only tools (`read_file`, `search_files`, `grep`, `list_dir`) run freely. Every consequential tool (`write_file`, `edit_file`, `run_shell`, …) is gated. The operator can Allow Once or Allow Always (scoped to a file, a directory, or a command shape). Allow Always applies for the rest of the session; Corbits also tries to remember it on disk so later sessions don't re-ask. If that write fails, the grant still holds this session and the operator is told remember did not stick.
- **Secret guard** — Path-keyed tools (`read_file`, `write_file`, …) hard-deny sensitive files (`.env`, `id_rsa`, `*.pem`, `.aws/credentials`, `.ssh/*`, `.git-credentials`, and similar), even with approval, `--dangerously-skip-permissions`, or `/yolo`. Template files like `.env.example` are exempt. Shell commands that _reference_ those paths (e.g. `bun --env-file=.env.staging run …`, `cat .env`) require explicit operator approval and never auto-run in auto mode; once approved, they proceed. Tool-result scrubbing still redacts credential-shaped output that reaches the transcript.
- **Catastrophic-command deny** — Destructive shell patterns that target system roots (`rm -rf /`, home, `/etc`, …), plus `mkfs`, `dd`, `sudo`, fork bombs, `curl | bash`, force-push, … are blocked before they run. Recursive delete of ordinary workspace paths is not hard-denied but requires operator approval (never auto in auto mode).
- **Constrained auto mode** — Default is on (`auto = true`). Pass `--no-auto` to start in ask mode, or `--auto` to force it on; there is currently no in-session key to toggle it. Auto mode auto-approves workspace file writes/edits/deletes and unconstrained shell without per-action prompts, but it is not a free-for-all:
  - **Denied** (must use `write_file` / `edit_file`): shell file mutations via output redirection, `tee`, `sed -i` / `perl -i`, interpreter inline programs or heredocs.
  - **Still asks**: dependency installs and remote runners (npm/yarn/pnpm/bun, pip, cargo, go, brew, `npx`/`bunx`, …), recursive `rm`, force or uncontained git worktree add/remove/prune (contained non-force add/remove/prune and `list` auto-allow), shell that references sensitive paths, and opaque unparseable wrappers (variable expansion or command substitution).
  - **Wrapper peel**: `bash`/`sh`/`zsh -c`, `xargs`, and transparent prefixes (`env`, `nice`, `timeout`, …) are expanded so the same deny/ask rules see the inner payload.
  - Paths outside the workspace and writes under the session state root still ask; mutating MCP and unknown tools still prompt.

- **Path sandboxing** — Tool path arguments are resolved against the working directory; paths that escape it are blocked unless `--dangerously-skip-permissions` / `/yolo` is on (secret-guard and authz hard denies still apply).
- **Write verification** — After every write/edit the file is re-read and compared to confirm the change actually landed; the result returned to the model (and shown to the operator) includes a bounded diff of the changed region — `write_file`, `edit_file`, `delete_file`, and each op inside `apply_patch` — so a follow-up `read_file` is never needed just to confirm an edit landed. A whole-file rewrite's diff is truncated (and says so) rather than blowing the result size cap.

## Slash Commands (TUI)

The TUI has an extensible slash-command framework. Built-ins include `/help` (shortcut + command overlay), `/model` (models-only picker for connected accounts; **Alt+A** adds a provider), `/settings`, `/permissions`, `/plugins`, `/clear`, `/new`, `/mcp`, and `/yolo` (persists as the user-global skip-permissions default; `--dangerously-skip-permissions` still forces this process; secret-guard and authz still apply; `/yolo [on|off|toggle]`, bare `/yolo` toggles), plus a `/<name>` command per available workflow. When a session starts with the persisted default already on, the TUI shows a startup notice ("Permission prompts are disabled by your saved default…") so the silent machine-wide default is never invisible; `corbits exec` prints the equivalent warning to stderr. Plugins can register additional commands.

**Default skills** exist out of the gate as first-party slash **actions**, not director names: `/implement`, `/plan`, `/refactor`, `/review`, `/pull-request-review`, `/create-issue`, `/scribe`, `/interview`, `/ast-grep`. Each one is a how-to playbook — the slash sends the skill body to the primary, which follows the steps. Skills do not assign identity or route the fleet; that stays on director system prompts. `/review` is how to review a branch; `/scribe` is how to maintain PRODUCT / ARCHITECTURE / IMPLEMENTATION; `/implement` is the per-commit review/build/critique loop; `/plan` authors an eng change plan (files, AC, non-goals, risks, ordered steps) and does not implement. `/create-issue` remains the tracker command: Linear MCP when available; otherwise it `ask_operator`s for the platform (GitHub etc.) and persists `Preferred issue tracker` in `.corbits/MEMORY.md` (GitHub via `gh issue create`). There is no first-party dispatch skill — Skywalker orchestrates natively. `git-rebase`, `linear-issue-workflow`, `style`, `philosophy`, `typescript`, and `opsh` stay `use_skill` only (`user-invocable: false`). Draper and emil are not slashes; they remain closed directors via `spawn_agent(agent=…)`. There is no catch-all worker. Slash names are also available to the model via `use_skill`. Disable the catalog in `/plugins` (`corbits-skills`) if you want them gone.

Providers are **models-first**: there is no standalone `/login` command. `/model` opens a **models-only list** (Recent, Favorites, then connected provider/model rows) — type-to-filter owns printable keys, so Connect is never a bare letter. **Alt+A** opens a dedicated add-provider selector over every first-class kind (OpenAI dual-path ChatGPT OAuth or API key, xAI, OpenCode Zen, Anthropic, Google, OpenCode Go, Z.AI Coding Plan, Custom), each annotated with its live account count and never filtered out for “already connected.” **Alt+F** toggles favorite on the highlighted model. **Alt+D** persists the highlighted pair as the default without switching the live session. Advanced provider drill-down (edit/delete/tiers) stays on the advanced surface, not a bare printable key while the model list is filtering. OAuth providers open their existing browser login with a named account step so multiple accounts per kind coexist (`codex/work`, …). API-key providers use the same named-instance step before the key (auth-only form: instance name + key + fixed catalog base URL), so personal and team keys land as distinct catalog rows (`openai/default`, `anthropic/work`, …); reusing a name re-keys that instance after confirm. Custom remains a free-form single endpoint (full manual form). Successful connect refreshes the catalog and reopens the model list focused on the new account’s default model. OpenCode Go routes each model by its protocol metadata (chat completions, OpenAI responses, or Anthropic messages) and can show subscription usage in the status bar when active (rolling 5h / weekly / monthly windows when the usage API responds; omitted on auth or network failure). When Go returns a quota or rate-limit error — including some HTTP 400 responses that carry limit payloads — Corbits classifies them so quota aborts cleanly and short provider rate limits remain retryable. On a free-tier or subscription quota hit, wait for the window to reset or use OpenCode Zen free models.

`/model` opens a dedicated full-screen modal — the single place agent configuration lives. The default view is models-only (Recent / Favorites / connected models); add-provider, tiers, and profiles remain reachable from the same surface without in-list “connect →” rows. A switch applies to the running session immediately (no restart): inference, permission identity, grant persistence identity, and advertised tool schemas cut over together, and the choice can be saved as this project's default (written to the per-repo selection file). Recent and favorite model pairs are stored in global settings (no credentials).

## Lifecycle Hooks

Config-driven `postTurn` and `postRun` hooks (TypeScript or shell) run automatically, discovered from `.corbits/hooks` (per-repo) and `~/.corbits/hooks` (global). `postTurn` receives aggregated turn context (tool calls, results, token usage, duration); `postRun` receives a run summary. The TUI hook panel lists discovered hooks and lets the user enable/disable them. See `docs/HOOKS.md`.

## Failure Modes and Recovery

### Stall (tool-only turns with no narration)

**What the user sees:** The agent runs several turns in a row that are all tool calls with no explanation of what it's doing. After a one-shot nudge to explain itself, if the pattern continues the session **auto-pauses**: it stops issuing new inferences and replies with "Auto-paused: the model ran N steps in a row without explaining its progress. Send a message to resume." The session is not aborted — sending any message resumes it.

The exact turn thresholds are model-family-dependent (tighter for models with observed runaway tool-only behavior); see "Main-session loop protection" in `docs/ARCHITECTURE.md`.

**Recovery:** Send a message to resume. To inspect state first, see `~/.corbits/projects/<project-key>/<session-id>/run.json` (or a legacy in-repo `.agent-state/` tree if not yet migrated).

### Permission denied (exec)

**What the user sees:** In a non-interactive `corbits exec` run, a consequential action that needs approval returns a tool error explaining that approval is unavailable.

**Recovery:** Re-run interactively (TUI), pre-approve via persisted approvals, narrow the action, re-run with `--dangerously-skip-permissions`, or use `/yolo` in the TUI (persists as the user-global default).

### Resume after interruption

**What the user sees:** `Ctrl+C` mid-run, network error, or crash. The last state is persisted.

**Recovery:** `corbits resume` reloads `RunState` and continues. Failed
sessions remain failed (still listed); a corrupt id gets a short recovery
line instead of a path dump.

## Configuration

Providers and models are configured in `~/.corbits/settings.json` (holds providers + credentials), with a selection-only per-repo `.corbits/settings.json` override. Select at launch with `--provider` / `--model`, or point at an alternate file with `--config <path>`. `--config` only overrides where provider _definitions_ come from; it composes with, rather than replaces, credentials for codex/xai OAuth-profile providers, which live in separate home-level auth stores (`~/.corbits/codex-auth.json`, `xai-auth.json`) and are merged into the catalog regardless of `--config`. Credentials are read only from these settings files and the OAuth auth stores — there is no environment-variable override and `.env` files are not loaded, so a stale or exported key can't shadow the configured provider. The agent is denied read access to both settings files.

## Optional Capabilities (plugins)

Capabilities beyond the core toolset are opt-in plugins, enabled per workspace through the `/plugins` UI — nothing is wired in until enabled, except the first-party skills catalog (`corbits-skills`), which is on by default and can be turned off in `/plugins`.

- **Web search and fetch** — `web_search`/`web_fetch` are always-on built-in core tools, no plugin or API key required. `web_fetch` runs in-process (Bun native `fetch()`) with SSRF guarding, a 5 MB response cap, and HTML-to-markdown conversion; `web_search` calls a keyless hosted MCP provider (Exa by default, Parallel optional). See `docs/ARCHITECTURE.md` for details.

## Multi-agent (sub-agents)

The primary session is always **orchestrator** (single-agent mode is gone). Its identity is **Skywalker** (product name remains Corbits Code; when asked its name, answer Skywalker): classify work, DIY tiny/single-file/one-route product edits, dispatch a **closed fleet of 16 directors** for substantial work, track the fleet, and synthesize. Product mutation tools (`write_file` / `edit_file` / `delete_file`) are mounted on the primary (CORE / `SKYWALKER_TOOLS`) — path tools are the DIY surface; spawn remains the default for substantial, multi-file, parallel, or specialist work. Shell file-writes stay denied. MCP tools are not re-filtered by a product-write deny list (that list is gone). There is no static per-package write-path declaration (CL-6952 removed it — no shipped director ever set one). A concurrent dispatch landing on the same working directory as another still-running lane is recorded as a `conflict` intervention, not blocked. Operator slash recipes (`/implement`, `/plan`, `/refactor`, `/review`, `/pull-request-review`, `/create-issue`, `/scribe`, `/interview`, `/ast-grep`) tell Skywalker which directors to spawn for substantial work; tiny/bounded edits may run on the primary.

| Lane      | Directors                                                                              |
| --------- | -------------------------------------------------------------------------------------- |
| Primary   | skywalker                                                                              |
| Eng       | builder, explorer, counsel, intern, critic, greybeard, neckbeard, bruckheimer, gaasbot |
| Design    | draper, emil, rand                                                                     |
| Docs / QA | shakespeare, testsmith, tester                                                         |

There is **no catch-all worker**. `spawn_agent` requires `agent=…` or a non-general `intent` (implement/explore/plan/review→critic); bare dispatch and `intent=general` are refused. Named `spawn_agent(agent=…)` selects a director package without requiring a plugin profile, except `skywalker` which is the primary session identity and is refused as a spawned worker. Nested spawn is runtime-enforced: only skywalker (full fleet allowlist) and greybeard (intern/explorer/critic) may spawn; other workers have no fleet tools. Primary omits an allowlist so plugin profiles remain reachable from the main session.

Corbits Code fans work out to short-lived **sub-agents** — child agents with their own loop, tools, and checklist — while the primary session stays focused.

- **Agents** are runtime entities (primary session or child).
- **Tasks** are checklist items owned by one agent via `manage_tasks`.
- **Sub-agents** are spawned with `spawn_agent` / `wait_agents`.

Dispatch uses a structured brief (context / goal / optional goals seed) and returns a structured report. The TUI Agents strip and fleet board show who is running; live tool progress updates the status bar without dumping the child transcript into the parent chat. There is no turn budget. A tool-less final turn completes only with the four-heading report envelope; without it, one nudge is given and a second tool-less turn without the envelope salvages as `incomplete-report-stop`. A silent worker (no activity for `stallTimeoutMs`, opt-in) gets one continuation nudge, then salvages as `stalled` if a second consecutive check finds no activity. An opt-in `deadlineMs`, or an operator cancel, can also end a run early. Each of these returns a salvage report so a runaway or idle child cannot quietly burn a large token budget or look done after prose alone.

## Roadmap (planned, not yet shipped)

- **Fast provider/model switching** in the TUI with a persisted default.
- **Perpetual-session context management** — compaction/curation so a long-running session's context window stays bounded.

## Business Justification

- Raw feature throughput: the agent completes tasks without human babysitting.
- Cost transparency: every turn's token usage is tracked and visible live.
- Trust: secrets and catastrophic actions are unreachable; consequential actions are gated and auditable.
- Verifiable output: only builds that pass type-check and tests are accepted.
