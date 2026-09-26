import { describe, expect, test } from "bun:test";
import { isHttpServer } from "./is-http-server.js";

describe("isHttpServer", () => {
  test("HTTP wins when type is unset and url is set, even with command", () => {
    const config = { command: "run", url: "https://mcp.example.test" };
    expect(isHttpServer(config)).toBe(true);
  });

  test("type http wins even when command is also set", () => {
    const config = {
      type: "http" as const,
      command: "run",
      url: "https://mcp.example.test",
    };
    expect(isHttpServer(config)).toBe(true);
  });

  test("type stdio is not HTTP even when url is set", () => {
    expect(
      isHttpServer({
        type: "stdio",
        url: "https://mcp.example.test",
      }),
    ).toBe(false);
  });

  test("unset type and url is not HTTP", () => {
    expect(isHttpServer({})).toBe(false);
  });
});
