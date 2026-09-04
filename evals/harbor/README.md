# Harbor adapter for Corbits Code

Thin Harbor `BaseInstalledAgent` that runs headless product Corbits:

```text
corbits exec --cwd … --config … --provider … --model …
  --dangerously-skip-permissions <instruction>
```

No second agent loop. Credentials are translated from Harbor kwargs/env into a
temporary `settings.json` passed with `--config` — product Corbits still does
not read API keys from the environment.

## Layout

| Path                 | Role                                                   |
| -------------------- | ------------------------------------------------------ |
| `argv.py`            | Pure settings + argv builders (unit-tested, no Harbor) |
| `agent.py`           | `Corbits` installed agent (requires Harbor at import)  |
| `tasks/trivial/`     | Minimal smoke task (`hello.txt`)                       |
| `tests/test_argv.py` | Argv/settings unit tests                               |

## Prerequisites

1. **Harbor CLI** installed in the host Python env (`pip install harbor` / uv).
2. **Linux ELF `corbits` binary** for the task container (Darwin host builds
   will not run inside Linux Docker). Acquire one of:
   - Build on Linux: `bun run build:bin` → `dist/corbits`
   - Release / CI tarball that unpacks a `corbits` binary
3. **git** inside the task image (adapter also installs it via Harbor system
   packages). Corbits storage requires git — there is no git-less fallback.
4. **Provider API key** for the model under test.
5. **Provider `base_url`** — stock Harbor `-m xai/…` infers `https://api.x.ai/v1`. Override only when the catalog default is wrong. The adapter fail-closes if nothing resolves.

## Secrets / credentials

Pass a key through Harbor agent kwargs or env. The adapter writes it into the
temp settings file only:

| Source                  | Notes                                          |
| ----------------------- | ---------------------------------------------- |
| `api_key=` agent kwarg  | Preferred for one-off runs                     |
| `CORBITS_API_KEY`       | Generic adapter env                            |
| `{PROVIDER}_API_KEY`    | Only the selected provider, e.g. `XAI_API_KEY` |
| Harbor model connection | Falls back to `model_connection.api_key`       |

### Required base URL

`providers.<provider>.baseURL` is always written. Resolve it via one of:

| Source                     | Notes                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| `base_url=` agent kwarg    | Preferred for one-off runs                                            |
| Harbor configured URL      | `model_connection.configured_base_url` (`CORBITS_BASE_URL` / `XAI_BASE_URL` / …) |
| Harbor inferred catalog    | `model_connection.base_url` — e.g. xAI → `https://api.x.ai/v1` when an API key is present |
| `CORBITS_BASE_URL`         | Adapter env (also feeds Harbor configured URL)                        |

Stock `harbor run -m xai/grok-4.5` with `XAI_API_KEY` therefore does **not** need an explicit `base_url`. The adapter still fail-closes if nothing resolves.

Do **not** point Harbor cells at the grok-cli OAuth proxy (`https://cli-chat-proxy.grok.com/v1`). That URL only accepts OAuth tokens from `~/.corbits/xai-auth.json`, which Harbor containers do not have. Profile-qualified product cells (`xai/<profile>`, `codex/<profile>`) are OAuth; use an API-key provider name (`xai`, `openai`, …) inside Harbor.

Example values:

| Cell                          | Example `base_url`                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| xAI API key                   | `https://api.x.ai/v1` (Harbor infers this)                                           |
| Product OAuth / grok-cli path | Not usable in Harbor containers                                                      |
| OpenAI-compatible             | e.g. `https://api.openai.com/v1` or your cell's gateway                              |

Optional: `shell_timeout_ms=` → `shell.timeoutMs` in settings.

Default provider/model when Harbor does not pass `provider/model`: **xai** /
**grok-4.5**. Codex cells typically use `--model openai/<id>` (or pass
`provider=` / `model=` kwargs).

## Linux binary acquisition

The adapter installs the binary onto PATH from **one** of:

| Kwarg                 | Behavior                                          |
| --------------------- | ------------------------------------------------- |
| `corbits_binary_path` | Upload a host file into `/usr/local/bin/corbits`  |
| `corbits_binary_url`  | `curl` a raw binary URL                           |
| `corbits_tarball_url` | `curl` + extract; expects a `corbits` file inside |

Archive vs raw binary is detected from the URL suffix (`.tar.gz`, `.tgz`,
`.tar`) — the install script does not call `file(1)`.

If none are set and `corbits` is not already on PATH in the environment,
`install()` raises with this README pointer.

## Invoke

From the repo root (so `evals.harbor.agent` is importable):

```bash
# Unit tests (no Harbor package required; pytest may be absent)
PYTHONPATH=. python3 -m unittest evals.harbor.tests.test_argv -v

# Dry-run trivial task (needs Harbor CLI + Linux binary + API key)
export CORBITS_API_KEY=…   # or XAI_API_KEY=…
harbor run \
  -p evals/harbor/tasks/trivial \
  -a evals.harbor.agent:Corbits \
  -m xai/grok-4.5 \
  --ak corbits_binary_path=/absolute/path/to/linux/corbits
```

Equivalent kwargs via Harbor job config:

```yaml
agents:
  - name: evals.harbor.agent:Corbits
    kwargs:
      provider: xai
      model: grok-4.5
      api_key: ${CORBITS_API_KEY}
      base_url: https://api.x.ai/v1
      corbits_binary_path: /absolute/path/to/linux/corbits
      # or: corbits_tarball_url: https://…/corbits-linux.tar.gz
```

## Known gaps

- Trivial Harbor dry-run has been run locally (`hello.txt`, verifier reward 1.0)
  with OpenCode Go `mimo-v2.5`. Cost-capped Terminal-Bench smoke is the parent
  ticket **CL-6922** (the old CL-6924 slice ticket was canceled).
- This adapter does not parse Corbits trajectories into Harbor ATIF; exit
  metadata is limited to `context.metadata["exit_code"]` plus tee'd stdout in
  `/logs/agent/corbits.txt`.
