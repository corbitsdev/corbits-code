import { type } from "arktype";

const ObjectSchema = type({
  "properties?": "Record<string, unknown>",
  "required?": "string[]",
});

const Arguments = type("Record<string, unknown>");

const PropertySchema = type({
  "type?": "string | string[]",
  "nullable?": "boolean",
  "enum?": "unknown[]",
  "const?": "unknown",
  "minLength?": "number",
  "minItems?": "number",
  "pattern?": "string",
  "anyOf?": "unknown[]",
  "oneOf?": "unknown[]",
});

type PropertySchema = typeof PropertySchema.infer;

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function admitsType(schema: PropertySchema, value: unknown): boolean {
  if (schema.type === undefined) return true;
  if (value === null && schema.nullable === true) return true;
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  return allowed.includes(typeName(value));
}

// An uncompilable pattern proves nothing about the value, so it never rejects.
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return true;
  }
}

// Only the constraints an empty value can violate are checked; anything the
// schema does not express is left for the server to judge.
function admits(property: unknown, value: unknown): boolean {
  const schema = PropertySchema(property);
  if (schema instanceof type.errors) return true;
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (branches.length > 0 && !branches.some((branch) => admits(branch, value)))
    return false;
  if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
  if (schema.const !== undefined && schema.const !== value) return false;
  if (!admitsType(schema, value)) return false;
  if (typeof value === "string") {
    if ((schema.minLength ?? 0) > value.length) return false;
    if (schema.pattern !== undefined && !matchesPattern(schema.pattern, value))
      return false;
  }
  if (Array.isArray(value) && (schema.minItems ?? 0) > value.length)
    return false;
  return true;
}

function isRejectedPlaceholder(value: unknown, property: unknown): boolean {
  // Servers trim before checking length, so whitespace is judged as "".
  if (typeof value === "string")
    return value.trim() === "" && !admits(property, "");
  if (Array.isArray(value)) return value.length === 0 && !admits(property, []);
  return value === null && !admits(property, null);
}

export interface StripPlaceholderOpts {
  // A read tool's server takes a `null` filter literally (Linear's
  // list_issues reads `assignee: null` as "unassigned"), so padding narrows
  // the results; a write tool's `null` clears the field and must survive.
  // The cost: a deliberate JSON-null filter on a read tool is dropped for
  // every model, so asking for an unset field takes the string form a server
  // documents (Linear's `"null"`).
  nullMeansUnset: boolean;
}

/**
 * Drops optional arguments a model filled with an empty placeholder (`""`,
 * whitespace, `[]`, or `null`) that the property's own schema would reject,
 * so one padded field does not fail the whole call. With `nullMeansUnset`,
 * `null` on any declared optional property is dropped even where the schema
 * permits it. Other empty values the schema permits, required arguments,
 * undeclared keys, and any other value are forwarded unchanged.
 */
export function stripPlaceholderArguments(
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
  opts: StripPlaceholderOpts,
): Record<string, unknown>;
export function stripPlaceholderArguments(
  args: unknown,
  inputSchema: Record<string, unknown>,
  opts: StripPlaceholderOpts,
): unknown;
export function stripPlaceholderArguments(
  args: unknown,
  inputSchema: Record<string, unknown>,
  opts: StripPlaceholderOpts,
): unknown {
  const parsedArgs = Arguments(args);
  if (parsedArgs instanceof type.errors || Array.isArray(parsedArgs))
    return args;
  const schema = ObjectSchema(inputSchema);
  if (schema instanceof type.errors) return args;
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};
  return Object.fromEntries(
    Object.entries(parsedArgs).filter(([key, value]) => {
      if (required.has(key)) return true;
      if (
        opts.nullMeansUnset &&
        value === null &&
        Object.hasOwn(properties, key)
      )
        return false;
      return !isRejectedPlaceholder(value, properties[key]);
    }),
  );
}
