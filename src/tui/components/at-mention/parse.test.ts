import { describe, test, expect } from "bun:test";
import { parseAtState } from "./parse.js";

describe("parseAtState", () => {
  test("returns null for empty string", () => {
    expect(parseAtState("", 0)).toBeNull();
  });

  test("returns null when cursor is 0", () => {
    expect(parseAtState("@src", 0)).toBeNull();
  });

  test("detects @ at start of field", () => {
    expect(parseAtState("@src", 4)).toEqual({ prefix: "src", atStart: 0 });
  });

  test("detects @ mid-sentence", () => {
    expect(parseAtState("fix bug in @src/", 16)).toEqual({ prefix: "src/", atStart: 11 });
  });

  test("returns null when cursor is right after a space-terminated completion", () => {
    // "@src/foo.ts " — cursor after the trailing space, token is done
    expect(parseAtState("@src/foo.ts ", 12)).toBeNull();
  });

  test("returns null when there is no @ before cursor", () => {
    expect(parseAtState("hello world", 11)).toBeNull();
  });

  test("cursor immediately after @ gives empty prefix", () => {
    expect(parseAtState("@", 1)).toEqual({ prefix: "", atStart: 0 });
  });

  test("cursor inside a completed token still detects @", () => {
    // cursor at position 4 inside "@src/foo" — still inside the token
    expect(parseAtState("@src/foo", 4)).toEqual({ prefix: "src", atStart: 0 });
  });

  test("whitespace between @ and cursor breaks the token", () => {
    expect(parseAtState("@ src", 5)).toBeNull();
  });

  test("mid-sentence @ with partial path and cursor at end", () => {
    expect(parseAtState("describe @src/index", 19)).toEqual({ prefix: "src/index", atStart: 9 });
  });

  test("returns atStart of the correct @ when multiple @ present", () => {
    // cursor is inside the second @-token
    const val = "@first second @sec";
    expect(parseAtState(val, val.length)).toEqual({ prefix: "sec", atStart: 14 });
  });
});
