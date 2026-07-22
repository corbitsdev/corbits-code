# MCP Servers

Intercode connects to [Model Context Protocol](https://modelcontextprotocol.io)
servers to expose their tools to the agent. Configure them under `mcpServers` in
either settings file:

```text
~/.intercode/settings.json   # global — every repo (user-home trusted)
.intercode/settings.json     # per-repo — this project only (requires trust)
```

**Project trust:** When `mcpServers` comes from **local** `.intercode/settings.json`,
Intercode does **not** spawn or connect until each server is trusted for this
project. Trust is stored as a fingerprint of `{ name, type, command, args, url }`
in `.intercode/trust.json` (gitignored). The TUI prompts on first connect
(trust-on-first-use). Headless runs without a trust callback **fail closed** —
untrusted local servers are not connected.

Global MCP from `~/.intercode/settings.json` is treated as user-configured and
does not require project trust. Local settings **replace** global MCP entirely
when present (they do not merge).

Tools from connected servers are not advertised to the model up front; they are
registered for dispatch and surfaced on demand through dynamic tool discovery
(`tool_search`).

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

The first time Intercode connects to an http server that requires auth, the TUI
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
~/.intercode/mcp-auth/<slug>.json
```

The file basename is a **slug** derived from the MCP server `name` in settings:
non-alphanumeric characters (other than `_` and `-`) become `_`, so a display name
like `my/org` persists as `my_org.json`. Tokens never appear in `settings.json`.
The settings file holds only the URL; secret material stays in the per-server auth
file. Removing that file forces re-authorization on the next connect.
