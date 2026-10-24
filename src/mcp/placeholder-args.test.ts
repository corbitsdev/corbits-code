import { describe, expect, test } from "bun:test";
import { stripPlaceholderArguments } from "./placeholder-args.js";

const schema = {
  type: "object",
  properties: {
    query: { type: "string" },
    customView: { type: "string", minLength: 1 },
    fields: { type: "array", items: { type: "string" } },
    team: { type: "string" },
    assignee: { type: ["string", "null"] },
    parentId: { anyOf: [{ type: "string" }, { type: "null" }] },
    cycle: { type: "string", nullable: true },
    stage: { type: "string", enum: ["", "planned"] },
    priority: { type: "number" },
    includeArchived: { type: "boolean" },
    id: { type: "string" },
  },
  required: ["id"],
};

describe("stripPlaceholderArguments", () => {
  test("drops optional empty strings, whitespace, empty arrays, and disallowed null", () => {
    expect(
      stripPlaceholderArguments(
        { id: "CL-1", query: "", customView: " ", fields: [], team: null },
        schema,
      ),
    ).toEqual({ id: "CL-1" });
  });

  test("never changes required arguments", () => {
    expect(stripPlaceholderArguments({ id: "" }, schema)).toEqual({ id: "" });
    expect(stripPlaceholderArguments({ id: null }, schema)).toEqual({
      id: null,
    });
  });

  test("keeps null where the property schema allows it", () => {
    const args = { assignee: null, parentId: null, cycle: null };
    expect(stripPlaceholderArguments(args, schema)).toEqual(args);
  });

  test("keeps zero, false, and enum values", () => {
    const args = { priority: 0, includeArchived: false, stage: "" };
    expect(stripPlaceholderArguments(args, schema)).toEqual(args);
  });

  test("keeps meaningful values and leaves the caller's object intact", () => {
    const args = { query: "release", fields: ["title"], team: "" };
    expect(stripPlaceholderArguments(args, schema)).toEqual({
      query: "release",
      fields: ["title"],
    });
    expect(args).toEqual({ query: "release", fields: ["title"], team: "" });
  });

  test("treats a key the schema does not declare as optional", () => {
    expect(
      stripPlaceholderArguments({ id: "CL-1", extra: "" }, schema),
    ).toEqual({ id: "CL-1" });
  });

  test("forwards arguments unchanged when the schema shape is unusable", () => {
    const args = { query: "" };
    expect(
      stripPlaceholderArguments(args, { type: "object", required: "query" }),
    ).toEqual(args);
  });
});
