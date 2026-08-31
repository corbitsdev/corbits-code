import { describe, it, expect } from "bun:test";
import { getCommand } from "./registry.js";
import type { CommandContext } from "./registry.js";
import { registerBuiltInCommands } from "./built-in.js";
import { buildCostSummary } from "../../cost/cost-summary.js";

registerBuiltInCommands();

const makeCtx = (): CommandContext => ({
  signalClear: () => {},
});

describe("/help command", () => {
  it("is registered", () => {
    expect(getCommand("help")).toBeDefined();
  });

  it("requests the help overlay", () => {
    const ctx = makeCtx();
    const result = getCommand("help")!.handler("", ctx);
    expect(result).toEqual({ type: "overlay", overlay: "help" });
  });
});

describe("removed commands", () => {
  it("does not register verbose or diff", () => {
    expect(getCommand("verbose")).toBeUndefined();
    expect(getCommand("diff")).toBeUndefined();
  });

  it("/workflows is not registered", () => {
    expect(getCommand("workflows")).toBeUndefined();
  });

  it("/scope is not registered (slash commands live under enabled command plugins, e.g. a namespaced /ns sub)", () => {
    expect(getCommand("scope")).toBeUndefined();
  });

  it("/login is not registered (connect from /model or /connect)", () => {
    expect(getCommand("login")).toBeUndefined();
  });
});

describe("/connect command", () => {
  it("is registered", () => {
    expect(getCommand("connect")).toBeDefined();
  });

  it("requests the add-provider overlay", () => {
    expect(getCommand("connect")!.handler("", makeCtx())).toEqual({
      type: "overlay",
      overlay: "add-provider",
    });
  });
});

describe("/status command", () => {
  it("answers from the live fleet without sending anything to the model", () => {
    const ctx: CommandContext = {
      signalClear: () => {},
      getFleetStatus: () => "2 running (api 1:20, docs 0:04) · 1 done",
    };
    expect(getCommand("status")!.handler("", ctx)).toEqual({
      type: "message",
      text: "2 running (api 1:20, docs 0:04) · 1 done",
    });
  });

  it("says so rather than throwing when no fleet source is wired", () => {
    expect(getCommand("status")!.handler("", makeCtx())).toEqual({
      type: "message",
      text: "Fleet status is not available in this session.",
    });
  });
});

describe("removed approval command", () => {
  it("is not registered", () => {
    expect(getCommand("auto")).toBeUndefined();
  });
});

describe("/yolo command", () => {
  it("is registered", () => {
    expect(getCommand("yolo")).toBeDefined();
  });

  it("toggles skip-permissions when invoked bare", () => {
    let skip = false;
    const ctx: CommandContext = {
      signalClear: () => {},
      getSkipPermissions: () => skip,
      setSkipPermissions: (value) => {
        skip = value;
      },
    };
    expect(getCommand("yolo")!.handler("", ctx)).toEqual({
      type: "message",
      text: "Yolo mode on — permission prompts skipped. Saved as the default.",
    });
    expect(skip).toBe(true);
    expect(getCommand("yolo")!.handler("", ctx)).toEqual({
      type: "message",
      text: "Yolo mode off — permission prompts restored. Saved as the default.",
    });
    expect(skip).toBe(false);
    expect(getCommand("yolo")!.handler("toggle", ctx)).toEqual({
      type: "message",
      text: "Yolo mode on — permission prompts skipped. Saved as the default.",
    });
    expect(skip).toBe(true);
  });

  it("turns skip-permissions on and off explicitly", () => {
    let skip = false;
    const ctx: CommandContext = {
      signalClear: () => {},
      getSkipPermissions: () => skip,
      setSkipPermissions: (value) => {
        skip = value;
      },
    };
    expect(getCommand("yolo")!.handler("on", ctx)).toEqual({
      type: "message",
      text: "Yolo mode on — permission prompts skipped. Saved as the default.",
    });
    expect(skip).toBe(true);
    expect(getCommand("yolo")!.handler("off", ctx)).toEqual({
      type: "message",
      text: "Yolo mode off — permission prompts restored. Saved as the default.",
    });
    expect(skip).toBe(false);
  });

  it("rejects unknown arguments with usage", () => {
    const ctx: CommandContext = {
      signalClear: () => {},
      getSkipPermissions: () => false,
      setSkipPermissions: () => {},
    };
    expect(getCommand("yolo")!.handler("maybe", ctx)).toEqual({
      type: "message",
      text: "Usage: /yolo [on|off|toggle]",
    });
  });

  it("says so when skip-permissions is not wired", () => {
    expect(getCommand("yolo")!.handler("", makeCtx())).toEqual({
      type: "message",
      text: "Yolo mode is not available in this mode.",
    });
  });
});

describe("/model command", () => {
  it("is registered", () => {
    expect(getCommand("model")).toBeDefined();
  });

  it("opens the agent configuration modal", () => {
    expect(getCommand("model")!.handler("", makeCtx())).toEqual({ type: "modal", modal: "agent" });
  });

  it("/agent alias is not registered", () => {
    expect(getCommand("agent")).toBeUndefined();
  });
});

describe("/clear command", () => {
  it("returns a local message and does not send to the agent", () => {
    const ctx = makeCtx();
    const result = getCommand("clear")!.handler("", ctx);
    expect(result).toEqual({ type: "message", text: "Started a fresh session." });
  });

  it("calls signalClear", () => {
    let called = false;
    const ctx = makeCtx();
    ctx.signalClear = () => {
      called = true;
    };
    getCommand("clear")!.handler("", ctx);
    expect(called).toBe(true);
  });
});

describe("/new command", () => {
  it("returns a local message and does not send to the agent", () => {
    const ctx = makeCtx();
    const result = getCommand("new")!.handler("", ctx);
    expect(result).toEqual({ type: "message", text: "Started a fresh session." });
  });

  it("calls signalClear", () => {
    let called = false;
    const ctx = makeCtx();
    ctx.signalClear = () => {
      called = true;
    };
    getCommand("new")!.handler("", ctx);
    expect(called).toBe(true);
  });
});

describe("removed tier commands", () => {
  it("/fast, /standard, /clever are not registered", () => {
    expect(getCommand("fast")).toBeUndefined();
    expect(getCommand("standard")).toBeUndefined();
    expect(getCommand("clever")).toBeUndefined();
  });
});

describe("/cost command", () => {
  it("reports unavailable when the session supplies no summary", () => {
    const result = getCommand("cost")!.handler("", makeCtx());
    expect(result).toEqual({
      type: "message",
      text: "Cost tracking is not available in this session.",
    });
  });

  it("formats the summary the session supplies", () => {
    const ctx = makeCtx();
    ctx.getCostSummary = () =>
      buildCostSummary({
        modelId: "claude-x",
        pricingCache: null,
        totalCost: 0.42,
        formattedCost: "$0.4200",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        contextTokens: 160,
        contextIsEstimate: false,
      });
    const result = getCommand("cost")!.handler("", ctx);
    expect(result.type).toBe("message");
    expect((result as { text: string }).text).toContain("Model: claude-x");
    expect((result as { text: string }).text).toContain("Cost: $0.4200");
  });
});

describe("/feedback command", () => {
  it("is registered", () => {
    expect(getCommand("feedback")).toBeDefined();
  });

  it("arms multi-turn capture when invoked bare", () => {
    let armed = false;
    const ctx: CommandContext = {
      signalClear: () => {},
      beginFeedbackCapture: () => {
        armed = true;
      },
    };
    expect(getCommand("feedback")!.handler("", ctx)).toEqual({
      type: "message",
      text: "Please share your feedback. When done please hit enter. (Empty Enter cancels.)",
    });
    expect(armed).toBe(true);
  });

  it("submits inline text immediately", () => {
    const sent: string[] = [];
    const ctx: CommandContext = {
      signalClear: () => {},
      submitFeedback: (text) => {
        sent.push(text);
        return "Thanks — feedback sent.";
      },
    };
    expect(getCommand("feedback")!.handler("love the TUI", ctx)).toEqual({
      type: "message",
      text: "Thanks — feedback sent.",
    });
    expect(sent).toEqual(["love the TUI"]);
  });

  it("fails closed for bare /feedback when capture is not wired", () => {
    expect(getCommand("feedback")!.handler("", makeCtx())).toEqual({
      type: "message",
      text: "Feedback is not available in this mode.",
    });
  });

  it("explains when the feedback path is not wired", () => {
    expect(getCommand("feedback")!.handler("x", makeCtx())).toEqual({
      type: "message",
      text: "Feedback is not available in this mode.",
    });
  });
});
