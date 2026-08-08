import { defineMcpToolFactory } from "@corbits/mcp-adapter";

const OPEN_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

// Static declaration of Linear's hosted MCP tool surface. This list is a
// snapshot, not a live query -- see the package README for what happens
// when it drifts from the server's real tool list.
export const linear = defineMcpToolFactory({
  id: "@corbits/linear-mcp/linear",
  serverName: "linear",
  url: "https://mcp.linear.app/mcp",
  clientName: "corbits-code",
  toolDeclarations: [
    { name: "list_issues", description: "List issues in the Linear workspace.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "get_issue", description: "Get a single Linear issue by id.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "create_issue", description: "Create a Linear issue.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "update_issue", description: "Update an existing Linear issue.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "list_projects", description: "List projects in the Linear workspace.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "list_teams", description: "List teams in the Linear workspace.", inputSchema: OPEN_OBJECT_SCHEMA },
    {
      name: "search_documentation",
      description: "Search Linear's help documentation.",
      inputSchema: OPEN_OBJECT_SCHEMA,
    },
  ],
});
