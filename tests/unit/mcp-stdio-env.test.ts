import { describe, expect, test } from "bun:test";
import { buildStdioMcpProcessEnv } from "../../src/mcp/stdio-env.js";

describe("buildStdioMcpProcessEnv", () => {
  test("inherits only allowlisted parent vars", () => {
    const env = buildStdioMcpProcessEnv(
      {
        PATH: "/bin",
        HOME: "/home/op",
        OPENAI_API_KEY: "secret",
        INTERCODE_SESSION: "sess",
        AWS_SECRET_ACCESS_KEY: "aws",
      },
      undefined,
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/op" });
  });

  test("merges server env from settings on top", () => {
    const env = buildStdioMcpProcessEnv({ PATH: "/bin" }, { TOKEN: "mcp-token", PATH: "/custom" });
    expect(env).toEqual({ PATH: "/custom", TOKEN: "mcp-token" });
  });
});