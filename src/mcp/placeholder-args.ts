import { type } from "arktype";

const ObjectSchema = type({
  "properties?": "Record<string, unknown>",
  "required?": "string[]",
});

const PropertySchema = type({
  "type?": "string | string[]",
  "nullable?": "boolean",
  "enum?": "unknown[]",
  "const?": "unknown",
  "anyOf?": "unknown[]",
  "oneOf?": "unknown[]",
});

function allowsNull(property: unknown): boolean {
  const parsed = PropertySchema(property);
  if (parsed instanceof type.errors) return false;
  if (parsed.nullable === true) return true;
  if (parsed.type === "null") return true;
  if (Array.isArray(parsed.type) && parsed.type.includes("null")) return true;
  return [...(parsed.anyOf ?? []), ...(parsed.oneOf ?? [])].some(allowsNull);
}

// A value the schema names explicitly is a deliberate choice, even when empty.
function isListedValue(property: unknown, value: unknown): boolean {
  const parsed = PropertySchema(property);
  if (parsed instanceof type.errors) return false;
  return parsed.enum?.includes(value) === true || parsed.const === value;
}

function isPlaceholder(value: unknown, property: unknown): boolean {
  if (isListedValue(property, value)) return false;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return value === null && !allowsNull(property);
}

/**
 * Drops optional arguments a model filled with an empty placeholder (`""`,
 * whitespace, `[]`, or `null` where the property does not allow it).
 * Required arguments and any other value are forwarded unchanged.
 */
export function stripPlaceholderArguments(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const schema = ObjectSchema(inputSchema);
  if (schema instanceof type.errors) return args;
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        required.has(key) || !isPlaceholder(value, schema.properties?.[key]),
    ),
  );
}
