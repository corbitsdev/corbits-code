import { describe, expect, test } from "bun:test";
import { stripPlaceholderArguments } from "./placeholder-args.js";

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
