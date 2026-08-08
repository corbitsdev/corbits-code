import { defineMcpToolFactory } from "@corbits/mcp-adapter";

// Static declaration of Linear's hosted MCP tool surface, including real
// per-tool argument schemas (not a bare open object) -- an empty schema
// gives the model no signal on what arguments a tool takes, which
// defeats the point of declaring named tools instead of a single
// dispatch-proxy tool. This list is a snapshot, not a live query -- see
// the package README for what happens when it drifts from the server's
// real tool list.
export const linear = defineMcpToolFactory({
  id: "@corbits/linear-mcp/linear",
  serverName: "linear",
  url: "https://mcp.linear.app/mcp",
  clientName: "corbits-code",
  toolDeclarations: [
    {
      name: "list_issues",
      description: "List issues in the Linear workspace.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search over issue title/description." },
          team: { type: "string", description: "Team name or ID to filter by." },
          project: { type: "string", description: "Project name or ID to filter by." },
          assignee: { type: "string", description: 'User ID, name, email, or "me".' },
          state: { type: "string", description: "Workflow state type or name to filter by." },
          limit: { type: "number", description: "Maximum results to return." },
        },
      },
    },
    {
      name: "get_issue",
      description: "Get a single Linear issue by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Issue ID or identifier (e.g. ENG-123)." } },
        required: ["id"],
      },
    },
    {
      name: "create_issue",
      description: "Create a Linear issue.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title." },
          team: { type: "string", description: "Team name or ID to create the issue under." },
          description: { type: "string", description: "Issue description as Markdown." },
          assignee: { type: "string", description: 'User ID, name, email, or "me".' },
          project: { type: "string", description: "Project name or ID to add the issue to." },
        },
        required: ["title", "team"],
      },
    },
    {
      name: "update_issue",
      description: "Update an existing Linear issue.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Issue ID or identifier to update." },
          title: { type: "string", description: "New issue title." },
          description: { type: "string", description: "New issue description as Markdown." },
          state: { type: "string", description: "Workflow state type or name to move the issue to." },
          assignee: { type: "string", description: 'User ID, name, email, or "me".' },
        },
        required: ["id"],
      },
    },
    {
      name: "list_projects",
      description: "List projects in the Linear workspace.",
      inputSchema: {
        type: "object",
        properties: {
          team: { type: "string", description: "Team name or ID to filter by." },
          query: { type: "string", description: "Free-text search over project name." },
        },
      },
    },
    {
      name: "list_teams",
      description: "List teams in the Linear workspace.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query." } } },
    },
    {
      name: "search_documentation",
      description: "Search Linear's help documentation.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Free-text search query." } },
        required: ["query"],
      },
    },
  ],
});
