/**
 * Prompt chrome: bare exit/quit routing and the labels the box's border carries.
 */
import { describe, expect, test } from "bun:test";
import { withTestRenderer } from "./harness";
import {
  createAppShell,
  noticeText,
  setPromptCostContext,
  setPromptModelLabel,
  setPromptWorkspace,
  setMcpNeedsAuth,
  setPluginNeedsAttention,
  setShellBridgeHooks,
  setShellExitHandler,
  setStatusFlash,
  submitPrompt,
} from "./shell";
import { RUNTIME_FLASH_MS } from "./runtime-notices";
import { UI } from "./theme";

async function withShell(
  fn: (shell: ReturnType<typeof createAppShell>) => void,
  columns = 80,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        title: "test",
        cwd: "/src/corbits-code",
        terminal: { columns, rows: 24 },
        wireKeys: false,
      });
      try {
        fn(shell);
      } finally {
        shell.dispose();
      }
    },
    { width: columns, height: 24 },
  );
}

describe("bare exit / quit at the prompt", () => {
  for (const word of ["exit", "quit", "  QUIT  "]) {
    test(`"${word}" runs the host exit handler instead of sending`, async () => {
      await withShell((shell) => {
        const sent: string[] = [];
        let exits = 0;
        setShellBridgeHooks(shell, {
          onSubmit: (text) => sent.push(text),
          onInterrupt: () => {},
          exclusive: true,
        });
        setShellExitHandler(shell, () => {
          exits += 1;
        });
        shell.prompt.value = word;
        submitPrompt(shell);
        expect(exits).toBe(1);
        expect(sent).toEqual([]);
        expect(shell.prompt.value).toBe("");
      });
    });
  }

  test("a message that merely mentions exit is sent normally", async () => {
    await withShell((shell) => {
      const sent: string[] = [];
      let exits = 0;
      setShellBridgeHooks(shell, {
        onSubmit: (text) => sent.push(text),
        onInterrupt: () => {},
        exclusive: true,
      });
      setShellExitHandler(shell, () => {
        exits += 1;
      });
      shell.prompt.value = "how do I exit";
      submitPrompt(shell);
      expect(exits).toBe(0);
      expect(sent).toEqual(["how do I exit"]);
    });
  });

  test("with no exit handler registered, exit is sent as a message", async () => {
    await withShell((shell) => {
      const sent: string[] = [];
      setShellBridgeHooks(shell, {
        onSubmit: (text) => sent.push(text),
        onInterrupt: () => {},
        exclusive: true,
      });
      shell.prompt.value = "exit";
      submitPrompt(shell);
      expect(sent).toEqual(["exit"]);
    });
  });
});

/** The rules hold StyledText; join their chunks for assertions. */
function ruleOf(rule: { content: unknown }): string {
  const content = rule.content;
  if (typeof content === "string") return content;
  const { chunks } = content as { chunks?: readonly { text?: string }[] };
  return (chunks ?? []).map((c) => c.text ?? "").join("");
}

describe("the model label rides the top border", () => {
  test("an unnamed session shows nothing — no placeholder, no session name", async () => {
    await withShell((shell) => {
      expect(shell.modelLabel).toBeNull();
      const top = ruleOf(shell.promptTopRule);
      expect(top).not.toContain(shell.baseTitle);
      expect(top).toMatch(/^╭─+╮$/u);
    });
  });

  test("the rule breaks around a right-aligned label and resumes either side", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, {
        profile: "anthropic",
        model: "opus",
        effort: "high",
      });
      const top = ruleOf(shell.promptTopRule);
      expect(top).toContain("anthropic · opus · high");
      expect(top).toMatch(/^╭─+ anthropic · opus · high ─╮$/u);
      expect(top.length).toBe(shell.layout.contentWidth);
    });
  });

  test("empty segments fall back to a plain rule", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { model: "opus" });
      setPromptModelLabel(shell, {});
      expect(shell.modelLabel).toBeNull();
      expect(ruleOf(shell.promptTopRule)).toMatch(/^╭─+╮$/u);
    });
  });
});

describe("mcp attention rides the top border", () => {
  test("mcp ! sits immediately left of the model label", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.6" });
      setMcpNeedsAuth(shell, ["granola"]);
      const top = ruleOf(shell.promptTopRule);
      expect(top).toMatch(/^╭─+ mcp ! ─ xai · grok 4.6 ─╮$/u);
      expect(noticeText(shell)).toBe("");
      expect(shell.layout.heights.notice).toBe(0);
    });
  });

  test("clearing auth drops the mark and leaves the model", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.6" });
      setMcpNeedsAuth(shell, ["granola"]);
      setMcpNeedsAuth(shell, []);
      expect(ruleOf(shell.promptTopRule)).toMatch(/^╭─+ xai · grok 4.6 ─╮$/u);
    });
  });
});

describe("plugin attention rides the top border", () => {
  test("plugin ! sits immediately left of the model label", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.6" });
      setPluginNeedsAttention(shell, true);
      const top = ruleOf(shell.promptTopRule);
      expect(top).toMatch(/^╭─+ plugin ! ─ xai · grok 4.6 ─╮$/u);
      expect(noticeText(shell)).toBe("");
    });
  });

  test("mcp and plugin combine into one attention run", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.6" });
      setMcpNeedsAuth(shell, ["granola"]);
      setPluginNeedsAttention(shell, true);
      const top = ruleOf(shell.promptTopRule);
      expect(top).toMatch(/^╭─+ mcp ! · plugin ! ─ xai · grok 4.6 ─╮$/u);
    });
  });

  test("clearing plugin attention drops the mark", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.6" });
      setPluginNeedsAttention(shell, true);
      setPluginNeedsAttention(shell, false);
      expect(ruleOf(shell.promptTopRule)).toMatch(/^╭─+ xai · grok 4.6 ─╮$/u);
    });
  });
});

describe("the workspace rides the bottom border", () => {
  test("directory and branch sit right-aligned, the lockup left", async () => {
    await withShell((shell) => {
      setPromptWorkspace(shell, {
        cwd: "/src/corbits-code",
        branch: "migration/opentui-tui",
      });
      const bottom = ruleOf(shell.promptBottomRule);
      expect(bottom).toMatch(
        /^╰─ .*corbits code ─+ \/src\/corbits-code \(migration\/opentui-tui\) ─╯$/u,
      );
      expect(bottom.length).toBe(shell.layout.contentWidth);
    });
  });

  test("no branch leaves the directory alone on the rule", async () => {
    await withShell((shell) => {
      setPromptWorkspace(shell, { cwd: "/src/corbits-code", branch: null });
      const bottom = ruleOf(shell.promptBottomRule);
      expect(bottom).toContain("/src/corbits-code ─╯");
      expect(bottom).not.toContain("(");
    });
  });

  test("the composed rule is exactly the content width at every size", async () => {
    for (const columns of [120, 80, 60, 48, 40]) {
      await withShell((shell) => {
        setPromptWorkspace(shell, {
          cwd: "/very/deep/nesting/of/directories/corbits-code",
          branch: "migration/opentui-tui",
        });
        expect(ruleOf(shell.promptTopRule).length).toBe(shell.layout.contentWidth);
        expect(ruleOf(shell.promptBottomRule).length).toBe(shell.layout.contentWidth);
      }, columns);
    }
  });
});

describe("narrow terminals degrade the rules instead of corrupting them", () => {
  test("at 60 columns both labels survive with the rule intact", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.5" });
      setPromptWorkspace(shell, {
        cwd: "/src/corbits-code",
        branch: "migration/opentui-tui",
      });
      const top = ruleOf(shell.promptTopRule);
      const bottom = ruleOf(shell.promptBottomRule);
      expect(top).toMatch(/^╭─+ xai · grok 4.5 ─╮$/u);
      expect(bottom).toContain("corbits code");
      expect(bottom).toContain("(migration/opentui-tui)");
      expect(bottom).toEndWith("─╯");
      expect(bottom.length).toBe(shell.layout.contentWidth);
    }, 60);
  });

  test("at 48 columns the mark yields so the workspace survives", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.5" });
      setPromptWorkspace(shell, {
        cwd: "/src/deep/nesting/corbits-code",
        branch: "migration/opentui-tui",
      });
      const top = ruleOf(shell.promptTopRule);
      const bottom = ruleOf(shell.promptBottomRule);
      expect(top).toMatch(/^╭─+ xai · grok 4.5 ─╮$/u);
      expect(bottom).not.toContain("corbits code");
      expect(bottom).toContain("(migration/opentui-tui)");
      // The elision is marked, and both corners still close the rule.
      expect(bottom).toContain("…");
      expect(bottom.startsWith("╰")).toBe(true);
      expect(bottom.endsWith("╯")).toBe(true);
      expect(bottom.length).toBe(shell.layout.contentWidth);
    }, 48);
  });

  test("a rule with no room for the workspace keeps the mark alone", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, {
        profile: "a-very-long-provider-name",
        model: "a-very-long-model-name",
      });
      setPromptWorkspace(shell, {
        cwd: "/src/deep/nesting/corbits-code",
        branch: "a-very-long-branch-name-indeed",
      });
      expect(ruleOf(shell.promptTopRule)).toMatch(/^╭─+╮$/u);
      expect(ruleOf(shell.promptBottomRule)).toBe("╰─ corbits code ─────╯");
    }, 22);
  });
});

describe("no permanent hint strip", () => {
  test("the transient row is empty and unrowed on an idle shell", async () => {
    await withShell((shell) => {
      expect(noticeText(shell)).toBe("");
      expect(shell.notice.visible).toBe(false);
      expect(shell.layout.heights.notice).toBe(0);
    });
  });

  test("state that is only sometimes true takes a row only while it is true", async () => {
    await withShell((shell) => {
      const lapse: (() => void)[] = [];
      setStatusFlash(shell, "copied 3 lines", {
        ttlMs: RUNTIME_FLASH_MS,
        schedule: (fn, ms) => {
          expect(ms).toBe(RUNTIME_FLASH_MS);
          lapse.push(fn);
          return () => {};
        },
      });
      expect(noticeText(shell)).toContain("copied 3 lines");
      expect(shell.layout.heights.notice).toBe(1);
      expect(shell.notice.visible).toBe(true);

      lapse[0]?.();
      expect(shell.statusFlash).toBeNull();
      expect(noticeText(shell)).toBe("");
      expect(shell.layout.heights.notice).toBe(0);
      expect(shell.notice.visible).toBe(false);
    });
  });

  test("a lapsed flash does not paint after the renderer is torn down without dispose", async () => {
    await withTestRenderer(async (h) => {
      const lapse: (() => void)[] = [];
      const shell = createAppShell(h.renderer, {
        title: "test",
        cwd: "/src/corbits-code",
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
        flashSchedule: (fn, ms) => {
          expect(ms).toBe(RUNTIME_FLASH_MS);
          lapse.push(fn);
          return () => {};
        },
      });
      setStatusFlash(shell, "copied 3 lines", { ttlMs: RUNTIME_FLASH_MS });
      h.destroy();
      expect(h.renderer.isDestroyed).toBe(true);
      expect(shell.disposed).toBe(false);
      expect(() => lapse[0]?.()).not.toThrow();
    });
  });

  test("the keys strip is gone from the frame entirely", async () => {
    await withShell((shell) => {
      const painted = [
        ruleOf(shell.promptTopRule),
        ruleOf(shell.promptBottomRule),
        noticeText(shell),
      ].join("\n");
      expect(painted).not.toContain("/ commands");
      expect(painted).not.toContain("@ files");
      expect(painted).not.toContain("^C stop");
    });
  });
});

interface RuleChunk {
  readonly text: string;
  readonly fg: unknown;
}

function ruleChunksOf(rule: { content: unknown }): RuleChunk[] {
  const content = rule.content;
  if (typeof content !== "object" || content === null) return [];
  const { chunks } = content as { chunks?: readonly { text?: string; fg?: unknown }[] };
  return (chunks ?? []).map((c) => ({ text: c.text ?? "", fg: c.fg }));
}

function fgHex(fg: unknown): string {
  if (typeof fg === "string") return fg.toLowerCase();
  if (fg && typeof fg === "object") {
    const rec = fg as { hex?: string; toHex?: () => string; buffer?: ArrayLike<number> };
    if (typeof rec.hex === "string") return rec.hex.toLowerCase();
    if (typeof rec.toHex === "function") return rec.toHex().toLowerCase();
    if (rec.buffer !== undefined && rec.buffer.length >= 3) {
      const r = rec.buffer[0] ?? 0;
      const g = rec.buffer[1] ?? 0;
      const b = rec.buffer[2] ?? 0;
      return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return "";
}

function chunkMatching(chunks: readonly RuleChunk[], needle: string): RuleChunk | undefined {
  return chunks.find((c) => c.text.includes(needle));
}

describe("chrome attention and meter colors", () => {
  test("mcp ! and plugin ! paint in UI.warning", async () => {
    await withShell((shell) => {
      setPromptModelLabel(shell, { profile: "xai", model: "grok 4.6" });
      setMcpNeedsAuth(shell, ["granola"]);
      setPluginNeedsAttention(shell, true);
      const chunks = ruleChunksOf(shell.promptTopRule);
      const mark = chunkMatching(chunks, "mcp !");
      expect(mark).toBeDefined();
      expect(fgHex(mark?.fg)).toBe(UI.warning);
    });
  });

  test("context percent 0–60 is textDim, 61–80 warning, 81–100 error; cost stays textDim", async () => {
    await withShell((shell) => {
      const paint = (percent: number) => {
        setPromptCostContext(shell, {
          contextPercentUsed: percent,
          costLabel: "$0.42",
          contextIsEstimate: false,
        });
        return ruleChunksOf(shell.promptBottomRule);
      };

      const quiet = paint(60);
      expect(fgHex(chunkMatching(quiet, "60%")?.fg)).toBe(UI.textDim);
      expect(fgHex(chunkMatching(quiet, "$0.42")?.fg)).toBe(UI.textDim);

      const warning = paint(80);
      expect(fgHex(chunkMatching(warning, "80%")?.fg)).toBe(UI.warning);
      expect(fgHex(chunkMatching(warning, "$0.42")?.fg)).toBe(UI.textDim);

      const danger = paint(81);
      expect(fgHex(chunkMatching(danger, "81%")?.fg)).toBe(UI.error);
      expect(fgHex(chunkMatching(danger, "$0.42")?.fg)).toBe(UI.textDim);
    });
  });
});
