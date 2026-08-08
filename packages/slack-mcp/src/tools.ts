import { defineMcpToolFactory } from "@corbits/mcp-adapter";

const OPEN_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

// Slack's official remote MCP server (general availability February 2026):
// hosted at https://mcp.slack.com/mcp, OAuth 2.0 behind an admin approval
// flow. Confirmed hosted, not stdio, before this package was written.
//
// Static declaration of Slack's hosted MCP tool surface -- see the
// package README for what happens when it drifts from the server's real
// tool list.
export const slack = defineMcpToolFactory({
  id: "@corbits/slack-mcp/slack",
  serverName: "slack",
  url: "https://mcp.slack.com/mcp",
  clientName: "corbits-code",
  toolDeclarations: [
    { name: "search_messages", description: "Search Slack messages.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "list_channels", description: "List Slack channels.", inputSchema: OPEN_OBJECT_SCHEMA },
    {
      name: "get_channel_history",
      description: "Get recent messages from a Slack channel.",
      inputSchema: OPEN_OBJECT_SCHEMA,
    },
    { name: "post_message", description: "Post a message to a Slack channel.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "list_users", description: "List users in the Slack workspace.", inputSchema: OPEN_OBJECT_SCHEMA },
  ],
});
