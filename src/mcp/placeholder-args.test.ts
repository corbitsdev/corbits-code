import { describe, expect, test } from "bun:test";
import {
  advertiseNullForOptionalProperties,
  stripPlaceholderArguments,
} from "./placeholder-args.js";

const schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    query: { type: "string" },
    note: { type: "string", minLength: 0 },
    customView: { type: "string", minLength: 1 },
    view: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
    label: { oneOf: [{ type: "string", minLength: 1 }, { type: "string" }] },
    state: { type: "string", enum: ["open", "closed"] },
    stage: { type: "string", enum: ["", "planned"] },
    scope: { type: "string", const: "all" },
    slug: { type: "string", pattern: "^[a-z]+$" },
    suffix: { type: "string", pattern: "[a-z]*" },
    malformed: { type: "string", pattern: "(" },
    fields: { type: "array", items: { type: "string" } },
    labels: { type: "array", items: { type: "string" }, minItems: 1 },
    team: { type: "string" },
    assignee: { type: ["string", "null"] },
    parentId: { anyOf: [{ type: "string" }, { type: "null" }] },
    cycle: { type: "string", nullable: true },
    priority: { type: "number" },
    includeArchived: { type: "boolean" },
    anything: {},
  },
  required: ["id"],
};

const keepNull = { nullMeansUnset: false };
const dropNull = { nullMeansUnset: true };

describe("stripPlaceholderArguments", () => {
  test("forwards empty and whitespace strings the property schema permits", () => {
    const args = { query: "", note: "", team: " ", suffix: "", stage: "" };
    expect(stripPlaceholderArguments(args, schema, keepNull)).toEqual(args);
  });

  test("drops an empty or whitespace string where minLength is at least 1", () => {
    expect(
      stripPlaceholderArguments(
        { customView: " ", query: "x" },
        schema,
        keepNull,
      ),
    ).toEqual({ query: "x" });
    expect(
      stripPlaceholderArguments({ customView: "" }, schema, keepNull),
    ).toEqual({});
  });

  test("drops an empty string that an enum, const, or pattern rejects", () => {
    expect(
      stripPlaceholderArguments(
        { state: "", scope: " ", slug: "" },
        schema,
        keepNull,
      ),
    ).toEqual({});
  });

  test("forwards an empty string when the pattern does not compile", () => {
    expect(
      stripPlaceholderArguments({ malformed: "" }, schema, keepNull),
    ).toEqual({
      malformed: "",
    });
  });

  test("drops an empty array only where minItems is at least 1", () => {
    expect(
      stripPlaceholderArguments({ fields: [], labels: [] }, schema, keepNull),
    ).toEqual({ fields: [] });
  });

  test("drops an empty value the property type does not admit", () => {
    expect(
      stripPlaceholderArguments(
        { priority: "", includeArchived: " ", query: [] },
        schema,
        keepNull,
      ),
    ).toEqual({});
  });

  test("drops null only where the property schema disallows it", () => {
    expect(
      stripPlaceholderArguments(
        { team: null, priority: null },
        schema,
        keepNull,
      ),
    ).toEqual({});
    const nullable = {
      assignee: null,
      parentId: null,
      cycle: null,
      anything: null,
    };
    expect(stripPlaceholderArguments(nullable, schema, keepNull)).toEqual(
      nullable,
    );
  });

  test("drops a composite value only when every branch rejects it", () => {
    expect(stripPlaceholderArguments({ view: " " }, schema, keepNull)).toEqual(
      {},
    );
    expect(stripPlaceholderArguments({ view: null }, schema, keepNull)).toEqual(
      {
        view: null,
      },
    );
    expect(stripPlaceholderArguments({ label: "" }, schema, keepNull)).toEqual({
      label: "",
    });
  });

  test("never changes required arguments", () => {
    expect(stripPlaceholderArguments({ id: "" }, schema, keepNull)).toEqual({
      id: "",
    });
    expect(stripPlaceholderArguments({ id: null }, schema, keepNull)).toEqual({
      id: null,
    });
  });

  test("keeps zero and false", () => {
    const args = { priority: 0, includeArchived: false };
    expect(stripPlaceholderArguments(args, schema, keepNull)).toEqual(args);
  });

  test("keeps meaningful values and leaves the caller's object intact", () => {
    const args = { query: "release", fields: ["title"], customView: "" };
    expect(stripPlaceholderArguments(args, schema, keepNull)).toEqual({
      query: "release",
      fields: ["title"],
    });
    expect(args).toEqual({
      query: "release",
      fields: ["title"],
      customView: "",
    });
  });

  test("forwards a key the schema does not declare", () => {
    expect(
      stripPlaceholderArguments({ id: "CL-1", extra: "" }, schema, keepNull),
    ).toEqual({ id: "CL-1", extra: "" });
  });

  test("returns missing or non-object arguments as-is", () => {
    expect(stripPlaceholderArguments(null, schema, keepNull)).toBeNull();
    expect(
      stripPlaceholderArguments(undefined, schema, keepNull),
    ).toBeUndefined();
    expect(stripPlaceholderArguments("query", schema, keepNull)).toBe("query");
    const list = [""];
    expect(stripPlaceholderArguments(list, schema, keepNull)).toBe(list);
  });

  test("forwards arguments unchanged when the schema shape is unusable", () => {
    const args = { query: "" };
    expect(
      stripPlaceholderArguments(
        args,
        { type: "object", required: "query" },
        keepNull,
      ),
    ).toEqual(args);
  });
});

describe("stripPlaceholderArguments with nullMeansUnset", () => {
  test("drops null on optional properties whose schema permits it", () => {
    expect(
      stripPlaceholderArguments(
        {
          assignee: null,
          parentId: null,
          cycle: null,
          view: null,
          anything: null,
          query: "release",
        },
        schema,
        dropNull,
      ),
    ).toEqual({ query: "release" });
  });

  test("still applies the rejected-placeholder rule to other values", () => {
    expect(
      stripPlaceholderArguments(
        { customView: " ", fields: [], priority: 0, team: null },
        schema,
        dropNull,
      ),
    ).toEqual({ fields: [], priority: 0 });
  });

  test("never changes required arguments", () => {
    expect(stripPlaceholderArguments({ id: null }, schema, dropNull)).toEqual({
      id: null,
    });
  });

  test("forwards null on a key the schema does not declare", () => {
    expect(
      stripPlaceholderArguments({ extra: null }, schema, dropNull),
    ).toEqual({ extra: null });
  });
});

function propertiesOf(
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = inputSchema["properties"];
  if (typeof properties !== "object" || properties === null)
    throw new Error("schema has no properties");
  return Object.fromEntries(Object.entries(properties));
}

describe("advertiseNullForOptionalProperties", () => {
  // Shapes from Linear's list_issues and save_issue.
  const linear = {
    type: "object",
    properties: {
      id: { type: "string" },
      priority: { type: "number", description: "0=None, 1=Urgent" },
      customView: { type: "string", minLength: 1 },
      orderBy: { type: "string", enum: ["createdAt", "updatedAt"] },
      fields: { type: "array", items: { type: "string" } },
      assignee: { type: ["string", "null"] },
      slaType: {
        anyOf: [{ enum: ["all", "onlyBusinessDays"] }, { type: "null" }],
      },
      label: { oneOf: [{ type: "string" }, { type: "number" }] },
      filter: { type: "object", properties: { state: { type: "string" } } },
      scope: { type: "string", const: "all" },
      anything: { description: "untyped" },
    },
    required: ["id"],
    additionalProperties: false,
  };

  test("adds null to optional properties that reject it", () => {
    const out = advertiseNullForOptionalProperties(linear);
    expect(out["properties"]).toEqual({
      ...linear.properties,
      priority: { type: ["number", "null"], description: "0=None, 1=Urgent" },
      customView: { type: ["string", "null"], minLength: 1 },
      orderBy: {
        type: ["string", "null"],
        enum: ["createdAt", "updatedAt", null],
      },
      fields: { type: ["array", "null"], items: { type: "string" } },
      label: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
      },
      filter: {
        type: ["object", "null"],
        properties: { state: { type: "string" } },
      },
    });
    expect(out["required"]).toEqual(["id"]);
    expect(out["additionalProperties"]).toBe(false);
  });

  test("leaves required, already-nullable, untyped, and const properties as they are", () => {
    const before = propertiesOf(linear);
    const after = propertiesOf(advertiseNullForOptionalProperties(linear));
    for (const key of ["id", "assignee", "slaType", "scope", "anything"])
      expect(after[key]).toBe(before[key]);
  });

  test("leaves shapes the flat form cannot widen validly as they are", () => {
    const ambiguous = {
      type: "object",
      properties: {
        due: {
          type: "string",
          oneOf: [{ format: "date" }, { format: "time" }],
        },
        id: { type: "string", allOf: [{ type: "string" }] },
        code: { type: "string", not: { const: "x" } },
        ref: { type: "string", $ref: "#/$defs/S" },
        branchy: {
          type: "string",
          oneOf: [{ type: "string" }, { minLength: 1 }],
        },
        conditional: { type: "string", if: true, then: { type: "string" } },
        dynamic: { type: "string", $dynamicRef: "#/$defs/S" },
        exact: { const: "all" },
        openAPI: {
          type: "object",
          oneOf: [{ type: "string", nullable: true }, { type: "number" }],
        },
        strict: { type: "string", nullable: false },
      },
    };
    expect(advertiseNullForOptionalProperties(ambiguous)).toBe(ambiguous);
  });

  test("adds a null branch to anyOf whatever its other branches hold", () => {
    const opaque = {
      type: "object",
      properties: {
        either: { type: "string", anyOf: [{ $ref: "#/$defs/S" }] },
        nested: { type: "string", anyOf: [{ allOf: [{ type: "string" }] }] },
      },
    };
    expect(propertiesOf(advertiseNullForOptionalProperties(opaque))).toEqual({
      either: {
        type: ["string", "null"],
        anyOf: [{ $ref: "#/$defs/S" }, { type: "null" }],
      },
      nested: {
        type: ["string", "null"],
        anyOf: [{ allOf: [{ type: "string" }] }, { type: "null" }],
      },
    });
  });

  test("does not repeat a null that a keyword already lists", () => {
    const partial = {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", null] },
        view: {
          type: "string",
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        },
      },
    };
    expect(propertiesOf(advertiseNullForOptionalProperties(partial))).toEqual({
      state: { type: ["string", "null"], enum: ["open", null] },
      view: {
        type: ["string", "null"],
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      },
    });
  });

  test("leaves the input schema intact", () => {
    const before = structuredClone(linear);
    advertiseNullForOptionalProperties(linear);
    expect(linear).toEqual(before);
  });

  test("returns the same object when no property changes", () => {
    const nullable = {
      type: "object",
      properties: { assignee: { type: ["string", "null"] } },
    };
    expect(advertiseNullForOptionalProperties(nullable)).toBe(nullable);
    const empty = { type: "object", properties: {} };
    expect(advertiseNullForOptionalProperties(empty)).toBe(empty);
    const bare = { type: "object" };
    expect(advertiseNullForOptionalProperties(bare)).toBe(bare);
    const unusable = { type: "object", required: "id" };
    expect(advertiseNullForOptionalProperties(unusable)).toBe(unusable);
  });

  test("adds null only where the strip rule drops it again", () => {
    const before = propertiesOf(schema);
    const after = propertiesOf(advertiseNullForOptionalProperties(schema));
    const added = Object.keys(before).filter(
      (key) => after[key] !== before[key],
    );
    const dropped = Object.keys(before).filter(
      (key) =>
        !(key in stripPlaceholderArguments({ [key]: null }, schema, keepNull)),
    );
    expect(added).not.toEqual([]);
    // A const cannot be widened to null, so its null is dropped unadvertised.
    expect(dropped).toEqual(
      Object.keys(before).filter(
        (key) => added.includes(key) || key === "scope",
      ),
    );
  });
});
