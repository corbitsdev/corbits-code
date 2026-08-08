import { defineMcpToolFactory } from "@corbits/mcp-adapter";

const OPEN_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

// Static declaration of Granola's hosted MCP tool surface. This list is a
// snapshot, not a live query -- see the package README for what happens
// when it drifts from the server's real tool list.
export const granola = defineMcpToolFactory({
  id: "@corbits/granola-mcp/granola",
  serverName: "granola",
  url: "https://mcp.granola.ai/mcp",
  clientName: "corbits-code",
  toolDeclarations: [
    { name: "list_notes", description: "List Granola meeting notes.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "get_note", description: "Get a single Granola meeting note.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "search_notes", description: "Search Granola meeting notes.", inputSchema: OPEN_OBJECT_SCHEMA },
  ],
});
