import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createRenderer } from "./renderer.js";
import type { ReactorEmittedEvent } from "@intx/inference";

// Capture stdout/stderr writes during a test
function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { stdout.push(s); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { stderr.push(s); return true; }) as typeof process.stderr.write;
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function event(type: string, data: Record<string, unknown> = {}): ReactorEmittedEvent {
  return { type, seq: 0, data } as unknown as ReactorEmittedEvent;
}

describe("renderer — status bar", () => {
  test("every event updates the status bar on stderr", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("reactor.start"));
    cap.restore();
    expect(cap.stderr.join("")).toContain("interchange");
  });

  test("status bar uses \\r not \\n", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("reactor.start"));
    cap.restore();
    const bar = cap.stderr.join("");
    expect(bar).toContain("\r");
    expect(bar).not.toMatch(/interchange.*\n/);
  });

  test("status bar shows current op in amber for tool_call.start", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.start", { callId: "c1", name: "read_file" }));
    cap.restore();
    // amber escape before the op text
    expect(cap.stderr.join("")).toContain("\x1b[38;5;214m");
  });
});

describe("renderer — submit_plan journal block", () => {
  test("submit_plan tool.done writes a plan block to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c1", name: "submit_plan",
      arguments: {
        steps: [
          { file: "src/foo.ts", action: "add function", reason: "needed" },
          { file: "src/bar.ts", action: "update types", reason: "needed" },
        ],
      },
    }));
    renderer.render(event("tool.done", { result: { callId: "c1", content: "ok" } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("plan");
    expect(out).toContain("src/foo.ts");
    expect(out).toContain("src/bar.ts");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
  });
});

describe("renderer — write_file journal block", () => {
  test("write_file tool.done writes a write block with line count to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c2", name: "write_file",
      arguments: { path: "src/foo.ts", content: "line1\nline2\nline3" },
    }));
    renderer.render(event("tool.done", { result: { callId: "c2", content: "ok" } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("write");
    expect(out).toContain("src/foo.ts");
    expect(out).toContain("+3");
  });
});

describe("renderer — edit_file journal block", () => {
  test("edit_file tool.done writes an edit block with +/- counts to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c3", name: "edit_file",
      arguments: {
        path: "src/bar.ts",
        old_string: "line1\nline2",
        new_string: "line1\nline2\nline3\nline4",
      },
    }));
    renderer.render(event("tool.done", { result: { callId: "c3", content: "ok" } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("edit");
    expect(out).toContain("src/bar.ts");
    expect(out).toMatch(/\+\d/);
    expect(out).toMatch(/-\d/);
  });
});

describe("renderer — run_shell journal block", () => {
  test("run_shell success writes collapsed block with checkmark to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c4", name: "run_shell",
      arguments: { command: "bun test" },
    }));
    renderer.render(event("tool.done", { result: { callId: "c4", content: "14 passed" } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("shell");
    expect(out).toContain("bun test");
    expect(out).toContain("✓");
  });

  test("run_shell failure writes expanded block with cross to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c5", name: "run_shell",
      arguments: { command: "bun test" },
    }));
    renderer.render(event("tool.done", { result: { callId: "c5", content: "2 failed", isError: true } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("✗");
    expect(out).toContain("2 failed");
  });
});

describe("renderer — submit_output / reactor.done journal block", () => {
  test("submit_output tool.done writes done block with summary in green", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c6", name: "submit_output",
      arguments: { summary: "Task complete" },
    }));
    renderer.render(event("tool.done", { result: { callId: "c6", content: "ok" } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("done");
    expect(out).toContain("Task complete");
    expect(out).toContain("\x1b[32m"); // green
  });

  test("reactor.done writes done block to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("reactor.done"));
    cap.restore();
    expect(cap.stdout.join("")).toContain("done");
  });
});

describe("renderer — error blocks", () => {
  test("inference.error writes error block in red to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.error", {
      error: { category: "timeout", message: "request timed out" },
      partial: {},
    }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("error");
    expect(out).toContain("\x1b[31m"); // red
    expect(out).toContain("request timed out");
  });

  test("reactor.error writes error block in red to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("reactor.error", { error: "fatal crash", fatal: true }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("error");
    expect(out).toContain("fatal crash");
  });
});

describe("renderer — read-only tools produce no journal block", () => {
  test("read_file tool.done writes nothing to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c7", name: "read_file",
      arguments: { path: "src/foo.ts" },
    }));
    renderer.render(event("tool.done", { result: { callId: "c7", content: "file content" } }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });

  test("list_dir tool.done writes nothing to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), 30);
    renderer.render(event("inference.tool_call.end", {
      callId: "c8", name: "list_dir",
      arguments: { path: "src/" },
    }));
    renderer.render(event("tool.done", { result: { callId: "c8", content: "src/foo.ts" } }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });
});
