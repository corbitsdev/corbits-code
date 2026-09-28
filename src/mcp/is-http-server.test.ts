import { describe, expect, test } from "bun:test";
import { isHttpServer } from "./is-http-server.js";

describe("isHttpServer", () => {
  test("a url selects HTTP even when command is also set, with or without an explicit type", () => {
    const url = "https://mcp.example.test";
    const untyped = { command: "run", url };
    const typed = { type: "http" as const, command: "run", url };
    expect(isHttpServer(untyped)).toBe(true);
    expect(isHttpServer(typed)).toBe(true);
  });

  test("stdio type or no url is not HTTP", () => {
    expect(
      isHttpServer({ type: "stdio", url: "https://mcp.example.test" }),
    ).toBe(false);
    expect(isHttpServer({})).toBe(false);
  });
});
