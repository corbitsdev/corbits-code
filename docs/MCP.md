# MCP Servers

Corbits Code connects to [Model Context Protocol](https://modelcontextprotocol.io)
servers to expose their tools to the agent. Configure them under `mcpServers` in
either settings file:

```text
~/.corbits/settings.json   # global — every repo (user-home trusted)
.corbits/settings.json     # per-repo — this project only (requires trust)
```

## Built-in Exa Preset

Corbits Code includes a preset for Exa's MCP server, and it is **on by default**.
No settings entry is required. To disable it, set `enabled` to `false`:

```jsonc
{
  "mcpServers": {
    "exa": { "enabled": false },
  },
}
```

You may also spell the default explicitly:

```jsonc
{
  "mcpServers": [{ "name": "exa", "enabled": true }],
}
```

The preset connects to `https://mcp.exa.ai/mcp`. To use a different server under
the same name, provide an ordinary transport-bearing entry instead of an
`enabled` marker:

```jsonc
{
  "mcpServers": {
    "exa": { "type": "http", "url": "https://example.com/custom-exa-mcp" },
  },
}
```

Anonymous preset use requires no account, API key, OAuth provider, or callback
server and is rate limited by Exa; a `429` response means the anonymous limit has
been reached. Corbits Code adds no credentials or secret headers to the preset
connection. An authentication error is reported as a normal connection failure.

The built-in preset does not require project trust, even when it is injected
beside a local `.corbits/settings.json` MCP list. Local custom MCP servers still
require the normal project trust grant. A global `{ "exa": { "enabled": false } }`
disables the default even when local MCP settings omit `exa`; local settings can
explicitly re-enable the preset or override it with a custom transport-bearing
`exa` server.

The preset overlaps with the native `web_search` and `web_fetch` tools. Native
`web_search` remains lazy and unchanged. When the built-in Exa preset is active,
the canonical `web_fetch` tool uses Exa MCP's markdown-returning `web_fetch_exa`
for markdown requests and the in-process fetcher for text or HTML requests. The
raw `mcp__exa__web_fetch_exa` name is hidden to avoid duplicate fetch tools. If
the built-in Exa connection fails or does not advertise `web_fetch_exa`, a
markdown request returns an explicit Exa MCP error rather than falling back to
direct fetch. Native direct `web_fetch` is available only when the built-in Exa preset is
disabled or overridden by a custom `exa` MCP server. Other Exa MCP tools, such as
`mcp__exa__web_search_exa`, remain exposed through MCP namespacing.

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
does not require project trust. Local settings replace ordinary global MCP when
present. The built-in Exa default is still injected beside local MCP unless a
global or local `exa` entry disables or overrides it as described above.

Tools from connected servers are not advertised to the model up front; they are
registered for dispatch as soon as the server connects (including later in the
same turn) and surfaced on demand through dynamic tool discovery
(`tool_search`).

## Server Kinds

A server is reached one of two ways:

- **stdio** — launched as a subprocess via `command` (+ optional `args`, `env`).
- **http** — a remote Streamable-HTTP endpoint reached by `url` and authorized
  when the server requires OAuth.

`type` is optional: it defaults to `stdio` when `command` is set and `http` when
only `url` is set. Set it explicitly when you want to be unambiguous.

## Configuration Format

`mcpServers` accepts two equivalent shapes. The object form keys each server by
name:

```jsonc
{
  "mcpServers": {
    "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" },
  },
}
```

The array form carries the name inline:

```jsonc
{
  "mcpServers": [{ "name": "linear", "type": "http", "url": "https://mcp.linear.app/mcp" }],
}
```

A stdio server, for contrast, looks like:

```jsonc
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": { "LOG_LEVEL": "info" },
    },
  },
}
```

## Worked Example: Linear

Linear is a remote (http) MCP server, so the entry is just a name and URL — no
command, and no credentials in the config (Linear authorizes over OAuth):

```jsonc
{
  "mcpServers": {
    "linear": { "url": "https://mcp.linear.app/mcp" },
  },
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
~/.corbits/mcp-auth/<bounded-slug>-<endpoint-identity-sha256>.json
```

Credentials are scoped to the exact server name and endpoint URL, not the display
name alone. Corbits Code parses and normalizes the URL, removes its fragment, and
hashes the unambiguous `[serverName, normalizedURL]` tuple. The full path and query
remain part of the identity, so credentials cannot cross origins, paths, or query
variants. The bounded slug prefix is derived from the server name for readability;
the raw URL never appears in the filename.

Tokens never appear in `settings.json`. The settings file holds only the URL;
secret material stays in the endpoint-scoped auth file. Legacy name-only files
such as `exa.json` are ignored and left untouched because they cannot be tied safely
to an endpoint. Existing OAuth servers therefore require one-time re-authorization
after upgrading. Removing a scoped file likewise forces
re-authorization on the next connect.
