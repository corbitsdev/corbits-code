import type { MCPContentBlock } from "./client.js";

/**
 * Default model-facing keys for Linear write/list results. Identifier stays so
 * callers that only need the issue id still work; body/description do not.
 */
export const MCP_DEFAULT_ENTITY_FIELDS = [
  "id",
  "identifier",
  "url",
  "status",
  "title",
] as const;

const LINEAR_WRITE_TOOLS = new Set([
  "save_issue",
  "save_comment",
  "save_issue_label",
]);

const DEFAULT_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  status: ["state"],
  title: ["name"],
};

const NESTED_REF_FIELDS = ["id", "identifier", "name", "type"] as const;

export interface McpProjectionInput {
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  blocks: MCPContentBlock[];
  structuredContent?: Record<string, unknown> | unknown[];
}

export interface McpProjectionOutput {
  blocks: MCPContentBlock[];
  structuredContent?: Record<string, unknown> | unknown[];
}

export function applyMcpResultProjection(
  input: McpProjectionInput,
): McpProjectionOutput {
  const fields = resolveProjectionFields(
    input.serverName,
    input.toolName,
    input.args,
  );
  if (fields === undefined) {
    return {
      blocks: input.blocks,
      ...(input.structuredContent !== undefined
        ? { structuredContent: input.structuredContent }
        : {}),
    };
  }
  const shortenNestedRefs = fields.kind === "default";
  const applyAliases = fields.kind === "default";
  const blocks = input.blocks.map((block) =>
    projectBlock(block, fields.keys, shortenNestedRefs, applyAliases),
  );
  const structuredContent =
    input.structuredContent === undefined
      ? undefined
      : asProjectedStructured(
          projectMcpJsonValue(
            input.structuredContent,
            fields.keys,
            shortenNestedRefs,
            applyAliases,
          ),
        );
  return {
    blocks,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

export function projectMcpJsonValue(
  value: unknown,
  fields: readonly string[],
  shortenNestedRefs = true,
  applyAliases = true,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      isRecord(item)
        ? pickEntityFields(item, fields, shortenNestedRefs, applyAliases)
        : item,
    );
  }
  if (!isRecord(value)) return value;

  if (isListEnvelope(value)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      if (isProjectedList(item)) {
        out[key] = item.map((entry) =>
          isRecord(entry)
            ? pickEntityFields(entry, fields, shortenNestedRefs, applyAliases)
            : entry,
        );
      } else {
        out[key] = item;
      }
    }
    return out;
  }
  return pickEntityFields(value, fields, shortenNestedRefs, applyAliases);
}

function resolveProjectionFields(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): { kind: "default" | "fields"; keys: readonly string[] } | undefined {
  if (LINEAR_WRITE_TOOLS.has(toolName)) {
    return { kind: "default", keys: MCP_DEFAULT_ENTITY_FIELDS };
  }
  if (!isLinearServer(serverName) || !toolName.startsWith("list_")) {
    return undefined;
  }
  const requested = requestedFields(args.fields);
  if (requested === "passthrough") return undefined;
  if (requested === undefined) {
    return { kind: "default", keys: MCP_DEFAULT_ENTITY_FIELDS };
  }
  return { kind: "fields", keys: requested };
}

function isLinearServer(serverName: string): boolean {
  return /linear/i.test(serverName);
}

function requestedFields(
  fields: unknown,
): readonly string[] | "passthrough" | undefined {
  if (fields === undefined || fields === null) return undefined;
  if (fields === true) return "passthrough";
  if (typeof fields === "string") {
    const trimmed = fields.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed === "*" || trimmed.toLowerCase() === "all")
      return "passthrough";
    const parts = trimmed.split(/[\s,]+/).filter((part) => part.length > 0);
    return parts.length === 0 ? undefined : parts;
  }
  if (Array.isArray(fields)) {
    if (fields.length === 0) return undefined;
    if (fields.some((item) => item === "*" || item === true)) {
      return "passthrough";
    }
    const names = fields.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return names.length === 0 ? "passthrough" : names;
  }
  return "passthrough";
}

function projectBlock(
  block: MCPContentBlock,
  fields: readonly string[],
  shortenNestedRefs: boolean,
  applyAliases: boolean,
): MCPContentBlock {
  if (block.type !== "text" || typeof block.text !== "string") return block;
  const projected = projectJsonText(
    block.text,
    fields,
    shortenNestedRefs,
    applyAliases,
  );
  if (projected === block.text) return block;
  return { ...block, text: projected };
}

function projectJsonText(
  text: string,
  fields: readonly string[],
  shortenNestedRefs: boolean,
  applyAliases: boolean,
): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return JSON.stringify(
      projectMcpJsonValue(parsed, fields, shortenNestedRefs, applyAliases),
    );
  } catch {
    return text;
  }
}

function pickEntityFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  shortenNestedRefs: boolean,
  applyAliases: boolean,
): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of fields) {
    if (Object.hasOwn(record, key)) {
      const copied = copyField(record[key], shortenNestedRefs);
      if (copied !== undefined) out[key] = copied;
      continue;
    }
    if (!applyAliases) continue;
    const aliases = DEFAULT_FIELD_ALIASES[key];
    if (aliases === undefined) continue;
    for (const alias of aliases) {
      if (!Object.hasOwn(record, alias)) continue;
      const copied = copyField(record[alias], shortenNestedRefs);
      if (copied === undefined) break;
      out[key] = copied;
      if (!Object.hasOwn(out, alias)) out[alias] = copied;
      break;
    }
  }
  return out;
}

function copyField(value: unknown, shortenNestedRefs: boolean): unknown {
  if (!shortenNestedRefs || !isRecord(value)) return value;
  const nested = Object.create(null) as Record<string, unknown>;
  for (const key of NESTED_REF_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const inner = value[key];
    if (isRecord(inner) || Array.isArray(inner)) continue;
    nested[key] = inner;
  }
  return Object.keys(nested).length > 0 ? nested : undefined;
}

function asProjectedStructured(
  value: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (isRecord(value) || Array.isArray(value)) return value;
  return undefined;
}

function isListEnvelope(value: Record<string, unknown>): boolean {
  let sawRecordArray = false;
  let sawEmptyArray = false;
  for (const item of Object.values(value)) {
    if (!Array.isArray(item)) continue;
    if (item.some((entry) => isRecord(entry))) sawRecordArray = true;
    else if (item.length === 0) sawEmptyArray = true;
  }
  if (sawRecordArray) return true;
  if (!sawEmptyArray) return false;
  return !Object.hasOwn(value, "id") && !Object.hasOwn(value, "identifier");
}

function isProjectedList(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    (value.length === 0 || value.some((entry) => isRecord(entry)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
