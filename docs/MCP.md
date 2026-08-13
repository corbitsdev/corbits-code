# MCP Servers

Corbits Code connects to [Model Context Protocol](https://modelcontextprotocol.io)
servers to expose their tools to the agent. Configure them under `mcpServers` in
either settings file:

```text
~/.corbits/settings.json   # global — every repo (user-home trusted)
.corbits/settings.json     # per-repo — this project only (requires trust)
```

**Project trust:** When `mcpServers` comes from **local** `.corbits/settings.json`,
Corbits Code does **not** spawn or connect until each server is trusted for this
project. Trust is stored as a fingerprint of `{ name, type, command, args, url }`
in `~/.corbits/trust/<cwd-hash>.json` (outside the repo). The TUI prompts on
first connect (trust-on-first-use). Headless runs without a trust callback
**fail closed** — untrusted local servers are not connected.

The same per-cwd file also records project plugin trust; path-added plugins use
a separate global store (`~/.corbits/trust/path-plugins.json`) that never gates
MCP — see the trust model in `docs/PLUGINS.md`.

Global MCP from `~/.corbits/settings.json` is treated as user-configured and
does not require project trust. Local settings **replace** global MCP entirely
when present (they do not merge).

Tools from connected servers are not advertised to the model up front; they are
registered for free-name dispatch and surfaced on demand through dynamic tool
discovery (`tool_search`). Search returns schema cards into the conversation
history; the model then calls matched tools by exact name. The wire tools array
stays a fixed product prefix for the whole session (file/shell loop, product
loop tools, plus only harness-blocked substitutes: bounded `grep`/`search_files`
and `web_*`) so the provider tools cache stays hot — MCP never joins that prefix.

## Server Kinds

A server is reached one of two ways:

- **stdio** — launched as a subprocess via `command` (+ optional `args`, `env`).
- **http** — a remote Streamable-HTTP endpoint reached by `url` and authorized
  over OAuth.

`type` is optional: it defaults to `stdio` when `command` is set and `http` when
only `url` is set. Set it explicitly when you want to be unambiguous.

## Configuration Format

`mcpServers` accepts two equivalent shapes. The object form keys each server by
name:

```jsonc
{
  "mcpServers": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" }
  }
}
```

The array form carries the name inline:

```jsonc
{
  "mcpServers": [
    { "name": "linear", "type": "http", "url": "https://mcp.linear.app/mcp" }
  ]
}
```

A stdio server, for contrast, looks like:

```jsonc
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

## Worked Example: Linear

Linear is a remote (http) MCP server, so the entry is just a name and URL — no
command, and no credentials in the config (Linear authorizes over OAuth):

```jsonc
{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp" }
  }
}
```

Because only `url` is set, `type` defaults to `http`.

### Authorization on first run

The first time Corbits Code connects to an http server that requires auth, the TUI
shows an authorization prompt listing the server and its authorize URL:

- The URL is rendered as a clickable hyperlink (`open in browser`) in terminals
  that support OSC 8.
- Press **Alt+C** to copy the URL for pasting into a browser instead.

Complete the consent flow in the browser. A loopback callback server catches the
redirect and exchanges the authorization code for tokens automatically — the
prompt clears once the server is connected. No manual paste-back of a code is
needed.

### Where credentials live

OAuth tokens are written to:

```text
~/.corbits/mcp-auth/<slug>.json
```

The file basename is a **slug** derived from the MCP server `name` in settings:
non-alphanumeric characters (other than `_` and `-`) become `_`, so a display name
like `my/org` persists as `my_org.json`. Tokens never appear in `settings.json`.
The settings file holds only the URL; secret material stays in the per-server auth
file. Removing that file forces re-authorization on the next connect.
