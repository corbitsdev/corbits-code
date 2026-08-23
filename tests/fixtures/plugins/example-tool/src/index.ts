// A minimal worked example of a `kind: "tool"` plugin. It adds one agent tool,
// `echo`, that returns its input. Kept self-contained — it declares the small
// slice of the ToolPlugin contract it needs rather than importing core types, so
// the same pattern works for an out-of-tree plugin.

interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
interface ToolResult { callId: string; content: unknown; isError?: boolean }
interface ExtraTool {
  definition: { name: string; description: string; inputSchema: Record<string, unknown> };
  handler: (call: ToolCall, signal: AbortSignal) => Promise<ToolResult>;
}
interface ToolPlugin { tools: ExtraTool[] }

// Self-description for the loader and the /plugins UI. A tool plugin requires
// explicit consent before its tools are wired in.
export const manifest = {
  id: "example-tool",
  name: "Example Tool",
  kind: "tool" as const,
  description: "Demo tool plugin that adds an `echo` tool.",
};

// Factory invoked with the plugin's stored credentials (none here). The /plugins
// UI verifies a tool plugin by calling this and checking it yields tools.
export function createToolPlugin(_options: unknown): ToolPlugin {
  return {
    tools: [
      {
        definition: {
          name: "echo",
          description: "Echo back the provided text. Demonstrates a tool plugin.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", description: "Text to echo" } },
            required: ["text"],
          },
        },
        handler: async (call: ToolCall): Promise<ToolResult> => ({
          callId: call.id,
          content: String(call.arguments?.["text"] ?? ""),
        }),
      },
    ],
  };
}

export default createToolPlugin;
