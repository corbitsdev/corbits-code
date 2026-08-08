import { defineMcpToolFactory } from "@corbits/mcp-adapter";

const OPEN_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

// Static declaration of Exa's hosted MCP tool surface. This list is a
// snapshot, not a live query -- see the package README for what happens
// when it drifts from the server's real tool list.
//
// EXA_API_KEY is optional: unset, the server is used at its default rate
// limit; set, the key is passed through so Exa raises the caller's limit.
// The package installs, connects, and works fully with it unset.
export const exa = defineMcpToolFactory({
  id: "@corbits/exa-mcp/exa",
  serverName: "exa",
  url: "https://mcp.exa.ai/mcp",
  clientName: "corbits-code",
  apiKeyEnvVar: "EXA_API_KEY",
  apiKeyQueryParam: "exaApiKey",
  toolDeclarations: [
    { name: "web_search", description: "Search the web via Exa.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "get_contents", description: "Fetch page contents for a URL via Exa.", inputSchema: OPEN_OBJECT_SCHEMA },
    { name: "find_similar", description: "Find pages similar to a URL via Exa.", inputSchema: OPEN_OBJECT_SCHEMA },
  ],
});
