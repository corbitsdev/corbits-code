import { describe, expect, test } from "bun:test";
import { TOOL_PREVIEW_MAX, toolCallPreview } from "./tool-preview";

describe("toolCallPreview", () => {
  test("a shell call's subject is the command, not the tool name", () => {
    expect(toolCallPreview("run_shell", JSON.stringify({ command: "bun test ./src" }))).toBe(
      "bun test ./src",
    );
  });

  test("a file tool's subject is the path", () => {
    expect(
      toolCallPreview("read_file", JSON.stringify({ path: "src/subagent/session-store.ts" })),
    ).toBe("src/subagent/session-store.ts");
  });

  test("apply_patch preview uses the first envelope path", () => {
    const input = `*** Begin Patch
*** Add File: hello.txt
+Hello
*** End Patch
`;
    expect(toolCallPreview("apply_patch", JSON.stringify({ input }))).toBe("hello.txt");
  });

  test("grep shows the pattern", () => {
    expect(
      toolCallPreview("grep", JSON.stringify({ pattern: "currentToolPreview", path: "src" })),
    ).toBe("currentToolPreview");
  });

  test("spawn_agent prefers description over prompt", () => {
    expect(
      toolCallPreview(
        "spawn_agent",
        JSON.stringify({
          description: "map callers",
          prompt: "Find every call site of leaveObserve.",
        }),
      ),
    ).toBe("map callers");
  });

  test("empty or unknown args degrade to null so the lane falls back to the tool name", () => {
    expect(toolCallPreview("run_shell", "")).toBeNull();
    expect(toolCallPreview("run_shell", "{}")).toBeNull();
    expect(toolCallPreview("unknown_tool", JSON.stringify({ foo: 1 }))).toBeNull();
  });

  test("long subjects are hard-capped so they cannot shove other columns off the row", () => {
    // Avoid hex-like blobs (a-f0-9) — secret scrub would redact them first.
    const command = "z".repeat(TOOL_PREVIEW_MAX + 20);
    const preview = toolCallPreview("run_shell", JSON.stringify({ command }));
    expect(preview).not.toBeNull();
    expect(preview!.length).toBe(TOOL_PREVIEW_MAX);
    expect(preview!.endsWith("…")).toBe(true);
  });

  test("newlines collapse to a single-line subject", () => {
    expect(
      toolCallPreview("run_shell", JSON.stringify({ command: "bun test\n  --filter agent" })),
    ).toBe("bun test --filter agent");
  });

  test("secret-shaped fragments are scrubbed before the subject leaves the helper", () => {
    const preview = toolCallPreview(
      "run_shell",
      JSON.stringify({ command: "curl https://api.example.com/?api_key=supersecretvalue" }),
    );
    expect(preview).not.toBeNull();
    expect(preview).not.toContain("supersecretvalue");
    expect(preview).toContain("[REDACTED]");
  });
});
