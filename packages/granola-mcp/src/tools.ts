import { defineMcpToolFactory } from "@corbits/mcp-adapter";

// Static declaration of Granola's hosted MCP tool surface, including real
// per-tool argument schemas -- see the package README for what happens
// when it drifts from the server's real tool list.
export const granola = defineMcpToolFactory({
  id: "@corbits/granola-mcp/granola",
  serverName: "granola",
  url: "https://mcp.granola.ai/mcp",
  clientName: "corbits-code",
  toolDeclarations: [
    {
      name: "list_notes",
      description: "List Granola meeting notes.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number", description: "Maximum notes to return." } },
      },
    },
    {
      name: "get_note",
      description: "Get a single Granola meeting note.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Note ID." } },
        required: ["id"],
      },
    },
    {
      name: "search_notes",
      description: "Search Granola meeting notes.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Free-text search query." } },
        required: ["query"],
      },
    },
  ],
});
