import { describe, test, expect } from "bun:test";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { LastCycleSource, TokenUsage } from "@intx/types/runtime";

import { createRenderer } from "./agent/renderer.js";
import { createFaremeter, formatCost } from "./cost/faremeter.js";
import type { PricingCache } from "./cost/pricing-fetcher.js";

// Capture stdout/stderr writes during a test
function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    stdout.push(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    stderr.push(s);
    return true;
  }) as typeof process.stderr.write;
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
    const renderer = createRenderer(Date.now());
    renderer.render(event("reactor.start"));
    cap.restore();
    expect(cap.stderr.join("")).toContain("interchange");
  });

  test("status bar uses \\r not \\n", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(event("reactor.start"));
    cap.restore();
    const bar = cap.stderr.join("");
    expect(bar).toContain("\r");
    expect(bar).not.toMatch(/interchange.*\n/);
  });

  test("status bar shows current op in amber for tool_call.start", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(event("inference.tool_call.start", { callId: "c1", name: "read_file" }));
    cap.restore();
    // amber escape before the op text
    expect(cap.stderr.join("")).toContain("\x1b[38;5;214m");
  });
});

describe("renderer — manage_tasks journal block", () => {
  test("manage_tasks tool.done writes nothing to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c1",
        name: "manage_tasks",
        arguments: {
          tasks: [{ id: "1", title: "Add function", status: "in_progress" }],
        },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c1", content: "ok" } }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });
});
describe("renderer — write_file journal block", () => {
  test("write_file tool.done writes a write block with line count to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c2",
        name: "write_file",
        arguments: { path: "src/foo.ts", content: "line1\nline2\nline3" },
      }),
    );
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
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c3",
        name: "edit_file",
        arguments: {
          path: "src/bar.ts",
          old_string: "line1\nline2",
          new_string: "line1\nline2\nline3\nline4",
        },
      }),
    );
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
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c4",
        name: "run_shell",
        arguments: { command: "bun test" },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c4", content: "14 passed" } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("shell");
    expect(out).toContain("bun test");
    expect(out).toContain("✓");
  });

  test("run_shell failure writes expanded block with cross to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c5",
        name: "run_shell",
        arguments: { command: "bun test" },
      }),
    );
    renderer.render(
      event("tool.done", { result: { callId: "c5", content: "2 failed", isError: true } }),
    );
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("✗");
    expect(out).toContain("2 failed");
  });
});

describe("renderer — submit_output / reactor.done journal block", () => {
  test("submit_output tool.done writes done block with summary in green", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c6",
        name: "submit_output",
        arguments: { summary: "Task complete" },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c6", content: "ok" } }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("done");
    expect(out).toContain("Task complete");
    expect(out).toContain("\x1b[32m"); // green
  });

  test("reactor.done writes done block to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(event("reactor.done"));
    cap.restore();
    expect(cap.stdout.join("")).toContain("done");
  });
});

describe("renderer — error blocks", () => {
  test("inference.error writes error block in red to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.error", {
        error: { category: "timeout", message: "request timed out" },
        partial: {},
      }),
    );
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("error");
    expect(out).toContain("\x1b[31m"); // red
    expect(out).toContain("Request timed out");
  });

  test("inference.error surfaces Codex usage_limit_reached with reset ETA", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.error", {
        error: {
          category: "quota_exhausted",
          message: "Too Many Requests",
          statusCode: 429,
          raw: {
            detail: {
              error: {
                code: "usage_limit_reached",
                message: "You have reached your usage limit.",
                plan_type: "workspace_member",
                resets_in_seconds: 3435,
              },
            },
          },
        },
        partial: {},
      }),
    );
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("Codex usage limit reached");
    expect(out).toMatch(/Resets in ~/);
    expect(out).toContain("/model");
    expect(out).not.toContain("Too Many Requests");
  });

  test("reactor.error writes error block in red to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(event("reactor.error", { error: "fatal crash", fatal: true }));
    cap.restore();
    const out = cap.stdout.join("");
    expect(out).toContain("error");
    expect(out).toContain("fatal crash");
  });
});

describe("renderer — miniDiff truncation", () => {
  test("edit_file with more than 10 lines shows truncation marker", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    const longContent = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c-trunc",
        name: "edit_file",
        arguments: { path: "src/big.ts", old_string: longContent, new_string: longContent },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c-trunc", content: "ok" } }));
    cap.restore();
    expect(cap.stdout.join("")).toContain("more");
  });
});

describe("renderer — formatOp fallback", () => {
  test("unknown tool name is used as-is for op display", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.start", { name: "custom_tool", callId: "c-custom" }),
    );
    cap.restore();
    expect(cap.stderr.join("")).toContain("custom_tool");
  });
});

describe("renderer — inference.done clears op", () => {
  test("inference.done resets currentOp in status bar", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(event("inference.tool_call.start", { name: "run_shell", callId: "c-x" }));
    renderer.render(
      event("inference.done", {
        turn: { role: "assistant", content: [], model: "test", timestamp: 0 },
        usage: { input: 0, output: 0 },
        source: "test",
      }),
    );
    cap.restore();
    // After inference.done the status bar should no longer contain the op name
    const lastStderr = cap.stderr[cap.stderr.length - 1] ?? "";
    expect(lastStderr).not.toContain("running");
  });
});

describe("renderer — inference.usage updates cost display", () => {
  test("inference.usage causes the status bar to update", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    const stderrBefore = cap.stderr.length;
    renderer.render(
      event("inference.usage", {
        usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      }),
    );
    cap.restore();
    expect(cap.stderr.length).toBeGreaterThan(stderrBefore);
  });
});

describe("renderer — tool.start updates op", () => {
  test("tool.start sets op to the tool name", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(event("tool.start", { call: { name: "run_shell", id: "c-ts" } }));
    cap.restore();
    expect(cap.stderr.join("")).toContain("running");
  });
});

describe("renderer — connector.reply clears op", () => {
  test("connector.reply does not write to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(event("connector.reply", { messageId: "msg-1" }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });
});

describe("renderer — search_files and grep produce no journal block", () => {
  test("search_files tool.done writes nothing to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c-sf",
        name: "search_files",
        arguments: { pattern: "foo" },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c-sf", content: "results" } }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });

  test("grep tool.done writes nothing to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c-grep",
        name: "grep",
        arguments: { pattern: "bar" },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c-grep", content: "matches" } }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });
});

describe("renderer — read-only tools produce no journal block", () => {
  test("read_file tool.done writes nothing to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c7",
        name: "read_file",
        arguments: { path: "src/foo.ts" },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c7", content: "file content" } }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });

  test("list_dir tool.done writes nothing to stdout", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now());
    renderer.render(
      event("inference.tool_call.end", {
        callId: "c8",
        name: "list_dir",
        arguments: { path: "src/" },
      }),
    );
    renderer.render(event("tool.done", { result: { callId: "c8", content: "src/foo.ts" } }));
    cap.restore();
    expect(cap.stdout.join("")).toBe("");
  });
});

describe("renderer — mixed vs hidden-only session cost", () => {
  const pricingCache: PricingCache = {
    timestamp: 0,
    models: {
      "glm-5.1": {
        inputPricePerToken: 0.000002,
        outputPricePerToken: 0.00001,
        cacheReadPricePerToken: 0,
      },
      "gpt-5.6-luna": {
        inputPricePerToken: 0.000001,
        outputPricePerToken: 0.000008,
        cacheReadPricePerToken: 0,
      },
    },
  };

  const usage = (input: number, output: number): TokenUsage => ({
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
  });

  const CODEX_USAGE = usage(100_000, 20_000);
  const METERED_USAGE = usage(1_000, 500);
  const CODEX_SOURCE: LastCycleSource = {
    sourceId: "codex/default",
    provider: "codex-responses",
    model: "gpt-5.6-luna",
  };
  const METERED_SOURCE: LastCycleSource = {
    sourceId: "openai",
    provider: "openai",
    model: "glm-5.1",
  };

  function recastAtLiveModel(modelId: string, turns: TokenUsage[]): number {
    const faremeter = createFaremeter({ modelId, pricingCache });
    const combined: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    };
    for (const turn of turns) {
      combined.input += turn.input;
      combined.output += turn.output;
      combined.cacheRead += turn.cacheRead;
      combined.cacheWrite += turn.cacheWrite;
      combined.thinking += turn.thinking;
    }
    faremeter.addUsage(combined);
    return faremeter.getTotalCost();
  }

  test("Codex then metered shows the metered portion only, not a live-model recast", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), "glm-5.1", pricingCache);
    renderer.render(event("inference.done", { usage: CODEX_USAGE, source: CODEX_SOURCE }));
    renderer.render(event("inference.done", { usage: METERED_USAGE, source: METERED_SOURCE }));
    cap.restore();

    const meteredOnly = createFaremeter({ modelId: "glm-5.1", pricingCache });
    meteredOnly.addUsage(METERED_USAGE);
    const bar = cap.stderr[cap.stderr.length - 1] ?? "";
    const recast = recastAtLiveModel("glm-5.1", [CODEX_USAGE, METERED_USAGE]);

    expect(bar).toContain(formatCost(meteredOnly.getTotalCost()));
    expect(bar).toContain("metered portion only; session mixed billed and hidden usage");
    expect(bar).not.toContain("covered by ChatGPT subscription");
    expect(bar).not.toContain(formatCost(recast));
    expect(meteredOnly.getTotalCost()).toBeLessThan(recast);
  });

  test("hidden-only Codex still uses subscription copy", () => {
    const cap = captureOutput();
    const renderer = createRenderer(Date.now(), "gpt-5.6-luna", pricingCache);
    renderer.render(event("inference.done", { usage: CODEX_USAGE, source: CODEX_SOURCE }));
    cap.restore();

    const bar = cap.stderr[cap.stderr.length - 1] ?? "";
    expect(bar).toContain("covered by ChatGPT subscription (not billed per token)");
    expect(bar).not.toMatch(/\$\d/);
  });
});
