import { defineMcpToolFactory } from "@corbits/mcp-adapter";

// Slack's official remote MCP server (general availability February 2026):
// hosted at https://mcp.slack.com/mcp, OAuth 2.0 behind an admin approval
// flow. Confirmed hosted, not stdio, before this package was written --
// see https://mcpservers.org/remote-mcp-servers/slack.
//
// Static declaration of Slack's hosted MCP tool surface, including real
// per-tool argument schemas -- see the package README for what happens
// when it drifts from the server's real tool list.
export const slack = defineMcpToolFactory({
  id: "@corbits/slack-mcp/slack",
  serverName: "slack",
  url: "https://mcp.slack.com/mcp",
  clientName: "corbits-code",
  toolDeclarations: [
    {
      name: "search_messages",
      description: "Search Slack messages.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search query." },
          channel: { type: "string", description: "Channel name or ID to restrict the search to." },
        },
        required: ["query"],
      },
    },
    {
      name: "list_channels",
      description: "List Slack channels.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Free-text search over channel name." } },
      },
    },
    {
      name: "get_channel_history",
      description: "Get recent messages from a Slack channel.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name or ID." },
          limit: { type: "number", description: "Maximum messages to return." },
        },
        required: ["channel"],
      },
    },
    {
      name: "post_message",
      description: "Post a message to a Slack channel.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "Channel name or ID to post to." },
          text: { type: "string", description: "Message text." },
        },
        required: ["channel", "text"],
      },
    },
    {
      name: "list_users",
      description: "List users in the Slack workspace.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Free-text search over user name." } },
      },
    },
  ],
});
