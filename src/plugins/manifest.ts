import { type } from "arktype";

// A plugin self-describes through a `manifest` export. The `kind` drives how the
// plugin is wired: "web" provides the web_search/web_fetch backend, "command"
// contributes slash commands (a workflow is just a command that fans out to
// prompts/subagents), "tool" adds agent tools, and "agent" contributes sub-agent
// profiles (tier, capabilities, system prompt). `credentials` declares what the
// /plugins UI must collect before the plugin can run (stored in the global
// settings). Every installable plugin must declare a manifest to be wired in.
export type PluginKind = "web" | "command" | "tool" | "agent" | "workflow";

export type PluginCredentialField = {
  key: string;
  label: string;
  description?: string;
  secret?: boolean;
};

export type PluginManifest = {
  id: string;
  name: string;
  // Required: every consumer routes strictly by kind, so a kind-less manifest
  // would be a silent dead path (parses, lists, enables, but wires nothing).
  kind: PluginKind;
  description?: string;
  credentials?: PluginCredentialField[];
};

const PluginCredentialFieldSchema = type({
  key: "string>0",
  label: "string>0",
  "description?": "string",
  "secret?": "boolean",
});

export const PluginManifestSchema = type({
  id: "string>0",
  name: "string>0",
  kind: "'web' | 'command' | 'tool' | 'agent' | 'workflow'",
  "description?": "string",
  "credentials?": PluginCredentialFieldSchema.array(),
});

export function parsePluginManifest(value: unknown): PluginManifest | null {
  const result = PluginManifestSchema(value);
  return result instanceof type.errors ? null : (result as PluginManifest);
}
