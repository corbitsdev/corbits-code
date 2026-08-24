/**
 * Minimal JSON Schema (draft-07 subset) validator for submit_result payloads
 * (CL-6946). No JSON-Schema validation library is in the dependency tree
 * (arktype validates its own type language, not arbitrary JSON Schema
 * documents) — this covers the subset director packages need to declare a
 * structured output shape: type, required, properties, items, enum, and the
 * common string/number bounds. Not a general-purpose validator.
 */

export type JsonSchema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeOf(value) === expected;
}

/** Validate `value` against `schema`, returning human-readable error strings (empty = valid). */
export function validateJsonSchema(schema: JsonSchema, value: unknown, path = "result"): string[] {
  const errors: string[] = [];

  const expectedType = schema.type;
  if (typeof expectedType === "string" && !matchesType(value, expectedType)) {
    errors.push(`${path}: expected type "${expectedType}", got "${typeOf(value)}"`);
    return errors; // further checks are meaningless on the wrong type
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((v) => deepEqual(v, value))) {
    errors.push(`${path}: value is not one of the allowed enum values`);
  }

  if (typeOf(value) === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !(key in obj)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    const properties = schema.properties;
    if (properties !== null && typeof properties === "object") {
      for (const [key, subSchema] of Object.entries(properties as Record<string, unknown>)) {
        if (key in obj && subSchema !== null && typeof subSchema === "object") {
          errors.push(...validateJsonSchema(subSchema as JsonSchema, obj[key], `${path}.${key}`));
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(
        properties !== null && typeof properties === "object"
          ? Object.keys(properties as Record<string, unknown>)
          : [],
      );
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push(`${path}: unexpected property "${key}" (additionalProperties: false)`);
        }
      }
    }
  }

  if (typeOf(value) === "array" && Array.isArray(value)) {
    const items = schema.items;
    if (items !== null && typeof items === "object") {
      value.forEach((item, i) => {
        errors.push(...validateJsonSchema(items as JsonSchema, item, `${path}[${i}]`));
      });
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: length ${value.length} is below minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: length ${value.length} exceeds maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} exceeds maximum ${schema.maximum}`);
    }
  }

  return errors;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
