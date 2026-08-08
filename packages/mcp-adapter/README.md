# @corbits/mcp-adapter

Shared logic for exposing a hosted, OAuth-protected MCP server as an
`interchange.tools` tool package. Per-server packages (`@corbits/linear-mcp`,
`@corbits/slack-mcp`, `@corbits/granola-mcp`, `@corbits/exa-mcp`) are thin
configuration over `defineMcpToolFactory` -- they should not duplicate
connection, OAuth, or dispatch logic.

## Static tool declarations

`interchange.tools` factories must declare their tool names at
construction time (`ToolFactoryMeta.definitions`), before any connection to
the MCP server exists -- the deploy-time capability walk enumerates a
package's tools without instantiating it. That forces a choice, since an
MCP server's real tool list is only known after connecting:

- **Hardcoded static list per server (chosen).** Matches the constraint
  above directly, keeps the model's tool menu meaningful (named tools with
  real descriptions) instead of one opaque dispatch tool, and costs
  nothing until the upstream server's tool list drifts.
- **Single dispatch-proxy tool.** Always correct regardless of upstream
  changes, but pushes tool selection into a single tool's freeform
  arguments the model has to get right blind -- worse ergonomics for no
  correctness win in the common case.
- **Cache the list from a prior connection.** Accurate after first use,
  but the very first install has nothing to declare (there is no prior
  connection yet), and it reintroduces a locally-written file the loader
  has to trust as if it were the package author's declaration.

**What happens when the real list drifts.** A tool the server has since
removed fails at `run()` with the server's own "unknown tool" error,
surfaced as a normal tool-call failure -- visible, not silent. A tool the
server has since added is invisible to the model until this package's
`toolDeclarations` is updated and republished. Keeping each server
package's declared list current with its upstream server is an ongoing
maintenance cost of this choice.

## Lazy connection

`defineMcpToolFactory` returns an `AnnotatedToolFactory` whose bundle
construction is synchronous and does no I/O. The first `run()` call lazily
connects over streamable HTTP and, if the server requires it, drives an
OAuth authorization round trip using an adapter-local callback server and
token store (`~/.corbits/mcp-auth/<server>.json`) -- the same pattern
Corbits Code's own TUI-facing MCP client uses, ported here so this package
has no import back into the parent repository's `src/` tree.
