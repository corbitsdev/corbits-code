import { type } from "arktype";

// A plugin self-describes through a `manifest` export. The `kind` drives how the
// plugin is wired: a "web" plugin provides the web_search/web_fetch backend, a
// "workflow"/"command" plugin contributes those, and an absent kind is a plain
// module the /plugins UI still lists. `credentials` declares what the /plugins
// UI must collect before the plugin can run (stored in the global settings).
export type PluginKind = "web" | "workflow" | "command";

export type PluginCredentialField = {
  key: string;
  label: string;
  description?: string;
  secret?: boolean;
};

export type PluginManifest = {
  id: string;
  name: string;
  kind?: PluginKind;
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
  "kind?": "'web' | 'workflow' | 'command'",
  "description?": "string",
  "credentials?": PluginCredentialFieldSchema.array(),
});

export function parsePluginManifest(value: unknown): PluginManifest | null {
  const result = PluginManifestSchema(value);
  return result instanceof type.errors ? null : (result as PluginManifest);
}
