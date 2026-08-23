import { afterEach, describe, test, expect } from "bun:test";
import {
  REASONING_EFFORTS,
  ROLE_DEFAULT_EFFORT,
  isReasoningEffort,
  supportedEfforts,
  validateEffort,
  cycleReasoningEffort,
  setModelReasoningCapabilities,
  modelReasoningCapability,
  clampEffort,
  pickEffortFromCascade,
  resolveEffortForRole,
  defaultEffortForModel,
  resolveSessionEffort,
} from "./reasoning-effort.js";
import { composePromptActionBarModelLabel } from "../tui/components/prompt-action-bar-label.js";

describe("REASONING_EFFORTS", () => {
  test("is ordered from least to most effort", () => {
    expect(REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });
});

describe("isReasoningEffort", () => {
  test("accepts known levels", () => {
    expect(isReasoningEffort("medium")).toBe(true);
  });
  test("rejects unknown values", () => {
    expect(isReasoningEffort("legendary")).toBe(false);
    expect(isReasoningEffort(3)).toBe(false);
  });
});

describe("supportedEfforts", () => {
  test("known reasoning model gets the default set without none or xhigh", () => {
    expect(supportedEfforts("gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
  });

  test("gpt-5.1 family includes none (disable) and xhigh", () => {
    expect(supportedEfforts("gpt-5.1")).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });

  test("codex provider takes low/medium/high/xhigh, no minimal or none", () => {
    expect(supportedEfforts("gpt-5.5", undefined, true)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(supportedEfforts("gpt-5.4-mini", undefined, true)).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("gpt-5.6 family additionally takes max and ultra on the codex backend", () => {
    expect(supportedEfforts("gpt-5.6-sol", undefined, true)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(supportedEfforts("gpt-5.6-terra", undefined, true)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(supportedEfforts("gpt-5.6-luna", undefined, true)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  test("the model name alone does not imply codex levels", () => {
    expect(supportedEfforts("gpt-5.5")).toEqual(["minimal", "low", "medium", "high"]);
  });

  test("unknown model gets the safe subset", () => {
    expect(supportedEfforts("some-random-model")).toEqual(["low", "medium", "high"]);
  });

  test("grok-4.6 includes xhigh", () => {
    expect(supportedEfforts("grok-4.6")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("grok-4.5 stays on the unknown-model subset without xhigh", () => {
    expect(supportedEfforts("grok-4.5")).toEqual(["low", "medium", "high"]);
  });

  test("grok-composer-2.5-fast stays on the unknown-model subset without xhigh", () => {
    expect(supportedEfforts("grok-composer-2.5-fast")).toEqual(["low", "medium", "high"]);
  });
});

describe("validateEffort", () => {
  test("accepts a supported level", () => {
    expect(validateEffort("gpt-5.1", "xhigh")).toEqual({ ok: true });
  });

  test("rejects an unsupported level with a clear message", () => {
    const result = validateEffort("gpt-5", "xhigh");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not support reasoning effort");
      expect(result.error).toContain("xhigh");
    }
  });

  test("rejects xhigh on unknown models", () => {
    expect(validateEffort("unknown", "xhigh").ok).toBe(false);
    expect(validateEffort("unknown", "minimal").ok).toBe(false);
  });

  test("accepts xhigh on grok-4.6 and rejects it on grok-4.5", () => {
    expect(validateEffort("grok-4.6", "xhigh")).toEqual({ ok: true });
    expect(validateEffort("grok-4.5", "xhigh").ok).toBe(false);
  });
});

describe("cycleReasoningEffort", () => {
  afterEach(() => setModelReasoningCapabilities({}));

  test("walks the gpt-5 ladder and wraps", () => {
    expect(cycleReasoningEffort("gpt-5", "minimal")).toBe("low");
    expect(cycleReasoningEffort("gpt-5", "low")).toBe("medium");
    expect(cycleReasoningEffort("gpt-5", "medium")).toBe("high");
    expect(cycleReasoningEffort("gpt-5", "high")).toBe("minimal");
  });

  test("unset gpt-5 cycles from the implicit medium default to high", () => {
    expect(cycleReasoningEffort("gpt-5", undefined)).toBe("high");
  });

  test("unset grok cycles from implicit high, matching an explicit high", () => {
    expect(cycleReasoningEffort("grok-4.6", undefined)).toBe(
      cycleReasoningEffort("grok-4.6", "high"),
    );
    expect(cycleReasoningEffort("grok-4.6", "high")).toBe("xhigh");
  });

  test("unset gpt-5.1 chat cycles from implicit none to minimal", () => {
    expect(cycleReasoningEffort("gpt-5.1", undefined)).toBe("minimal");
  });

  test("leftover unsupported effort cycles from the family default", () => {
    expect(cycleReasoningEffort("gpt-5", "xhigh")).toBe("high");
    expect(cycleReasoningEffort("gpt-5", "xhigh")).toBe(cycleReasoningEffort("gpt-5", "medium"));
  });

  test("grok leftover minimal cycles the same as unset / high", () => {
    expect(cycleReasoningEffort("grok-4.6", "minimal")).toBe(cycleReasoningEffort("grok-4.6", undefined));
    expect(cycleReasoningEffort("grok-4.6", "minimal")).toBe(cycleReasoningEffort("grok-4.6", "high"));
    expect(cycleReasoningEffort("grok-4.6", "minimal")).toBe("xhigh");
  });

  test("unknown models with rungs still start at supported[0] when no default exists", () => {
    expect(defaultEffortForModel("some-random-model")).toBeUndefined();
    expect(cycleReasoningEffort("some-random-model", undefined)).toBe("low");
  });

  test("returns undefined for a non-reasoning model", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    expect(cycleReasoningEffort("chat-only-model", "medium")).toBeUndefined();
  });

  test("wraps high to xhigh to low on grok-4.6", () => {
    expect(cycleReasoningEffort("grok-4.6", "high")).toBe("xhigh");
    expect(cycleReasoningEffort("grok-4.6", "xhigh")).toBe("low");
  });
});

describe("reasoning capability gate", () => {
  afterEach(() => setModelReasoningCapabilities({}));

  test("a model models.dev marks non-reasoning gets no effort options", () => {
    expect(supportedEfforts("gpt-4o", false)).toEqual([]);
  });

  test("an unknown capability falls back to the local heuristic", () => {
    expect(supportedEfforts("gpt-5", undefined)).toEqual(["minimal", "low", "medium", "high"]);
  });

  test("supportedEfforts reads the registry by default", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    expect(modelReasoningCapability("chat-only-model")).toBe(false);
    expect(supportedEfforts("chat-only-model")).toEqual([]);
    expect(supportedEfforts("model-not-in-registry")).toEqual(["low", "medium", "high"]);
  });

  test("validateEffort rejects any effort for a non-reasoning model", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    const result = validateEffort("chat-only-model", "low");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not support reasoning");
  });
});

describe("ROLE_DEFAULT_EFFORT", () => {
  test("orchestrator is higher than leaf", () => {
    expect(ROLE_DEFAULT_EFFORT.orchestrator).toBe("high");
    expect(ROLE_DEFAULT_EFFORT.leaf).toBe("medium");
    expect(REASONING_EFFORTS.indexOf(ROLE_DEFAULT_EFFORT.orchestrator)).toBeGreaterThan(
      REASONING_EFFORTS.indexOf(ROLE_DEFAULT_EFFORT.leaf),
    );
  });
});

describe("clampEffort", () => {
  test("returns desired when supported", () => {
    expect(clampEffort("medium", ["low", "medium", "high"])).toBe("medium");
  });

  test("picks the nearest supported rung", () => {
    // medium is between low and high; equidistant → first minimum wins (low).
    expect(clampEffort("medium", ["low", "high"])).toBe("low");
    expect(clampEffort("xhigh", ["low", "medium", "high"])).toBe("high");
    expect(clampEffort("none", ["low", "medium", "high"])).toBe("low");
  });

  test("empty supported yields undefined", () => {
    expect(clampEffort("medium", [])).toBeUndefined();
  });
});

describe("pickEffortFromCascade (precedence table)", () => {
  test("1. pin wins over role default and parent", () => {
    expect(
      pickEffortFromCascade({
        pin: "low",
        roleDefault: "medium",
        parentEffort: "high",
        supported: ["low", "medium", "high"],
      }),
    ).toBe("low");
  });

  test("1b. unsupported pin is clamped onto supported", () => {
    expect(
      pickEffortFromCascade({
        pin: "xhigh",
        roleDefault: "medium",
        parentEffort: "high",
        supported: ["low", "medium", "high"],
      }),
    ).toBe("high");
  });

  test("2. role default when supported (ignores parent)", () => {
    expect(
      pickEffortFromCascade({
        roleDefault: "medium",
        parentEffort: "high",
        supported: ["low", "medium", "high"],
      }),
    ).toBe("medium");
  });

  test("3. parent inheritance when role default is unsupported but parent is", () => {
    expect(
      pickEffortFromCascade({
        roleDefault: "medium",
        parentEffort: "high",
        supported: ["low", "high", "xhigh"],
      }),
    ).toBe("high");
  });

  test("4. clamp role default when neither role default nor parent is supported", () => {
    expect(
      pickEffortFromCascade({
        roleDefault: "medium",
        parentEffort: "xhigh",
        supported: ["none", "minimal", "low"],
      }),
    ).toBe("low");
  });

  test("5. empty supported yields undefined", () => {
    expect(
      pickEffortFromCascade({
        roleDefault: "medium",
        parentEffort: "high",
        supported: [],
      }),
    ).toBeUndefined();
  });
});

describe("resolveEffortForRole", () => {
  afterEach(() => setModelReasoningCapabilities({}));

  test("explicit pin wins over role default and parent", () => {
    expect(
      resolveEffortForRole({
        orchestrator: false,
        pin: "low",
        parentEffort: "high",
        model: "gpt-5",
      }),
    ).toBe("low");
    expect(
      resolveEffortForRole({
        orchestrator: true,
        pin: "minimal",
        parentEffort: "high",
        model: "gpt-5",
      }),
    ).toBe("minimal");
  });

  test("leaf role default is medium even when parent is high", () => {
    expect(
      resolveEffortForRole({
        orchestrator: false,
        parentEffort: "high",
        model: "gpt-5",
      }),
    ).toBe("medium");
  });

  test("orchestrator role default is high even when parent is low", () => {
    expect(
      resolveEffortForRole({
        orchestrator: true,
        parentEffort: "low",
        model: "gpt-5",
      }),
    ).toBe("high");
  });

  test("non-reasoning model yields undefined even with parent effort", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    expect(
      resolveEffortForRole({
        orchestrator: false,
        parentEffort: "high",
        model: "chat-only-model",
      }),
    ).toBeUndefined();
  });

  test("codex leaf still gets medium (not parent xhigh)", () => {
    expect(
      resolveEffortForRole({
        orchestrator: false,
        parentEffort: "xhigh",
        model: "gpt-5.6-sol",
        isCodex: true,
      }),
    ).toBe("medium");
  });

  test("codex orchestrator still gets high", () => {
    expect(
      resolveEffortForRole({
        orchestrator: true,
        parentEffort: "low",
        model: "gpt-5.6-sol",
        isCodex: true,
      }),
    ).toBe("high");
  });
});

describe("defaultEffortForModel", () => {
  afterEach(() => setModelReasoningCapabilities({}));

  test("grok family defaults to high", () => {
    expect(defaultEffortForModel("grok-4.6")).toBe("high");
    expect(defaultEffortForModel("grok-4.5")).toBe("high");
  });

  test("gpt-5 and o-series default to medium", () => {
    expect(defaultEffortForModel("gpt-5")).toBe("medium");
    expect(defaultEffortForModel("o1")).toBe("medium");
    expect(defaultEffortForModel("o3-mini")).toBe("medium");
    expect(defaultEffortForModel("o4-mini")).toBe("medium");
  });

  test("gpt-5.1 chat defaults to none when none is on the ladder", () => {
    expect(supportedEfforts("gpt-5.1").includes("none")).toBe(true);
    expect(defaultEffortForModel("gpt-5.1")).toBe("none");
    expect(defaultEffortForModel("gpt-5.1", false)).toBe("none");
  });

  test("Codex defaults to medium", () => {
    expect(defaultEffortForModel("gpt-5.6-sol", true)).toBe("medium");
    expect(defaultEffortForModel("gpt-5.1-codex", true)).toBe("medium");
  });

  test("empty ladder yields undefined", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    expect(defaultEffortForModel("chat-only-model")).toBeUndefined();
  });

  test("unknown models with rungs have no family default", () => {
    expect(supportedEfforts("some-random-model").length).toBeGreaterThan(0);
    expect(defaultEffortForModel("some-random-model")).toBeUndefined();
  });
});

describe("resolveSessionEffort", () => {
  afterEach(() => setModelReasoningCapabilities({}));

  test("empty ladder yields undefined even when configured", () => {
    setModelReasoningCapabilities({ "chat-only-model": false });
    expect(resolveSessionEffort("chat-only-model", "high")).toBeUndefined();
  });

  test("keeps a supported configured level", () => {
    expect(resolveSessionEffort("gpt-5", "low")).toBe("low");
    expect(resolveSessionEffort("grok-4.6", "low")).toBe("low");
  });

  test("falls back to the family default when unset or unsupported", () => {
    expect(resolveSessionEffort("gpt-5", undefined)).toBe("medium");
    expect(resolveSessionEffort("gpt-5", "xhigh")).toBe("medium");
    expect(resolveSessionEffort("grok-4.6", undefined)).toBe("high");
    expect(resolveSessionEffort("gpt-5.1", undefined)).toBe("none");
    expect(resolveSessionEffort("gpt-5.6-sol", undefined, true)).toBe("medium");
    expect(resolveSessionEffort("some-random-model", undefined)).toBeUndefined();
  });
});

describe("prompt action bar effort label", () => {
  test("joiner stays a dumb concatenation of the resolved session effort", () => {
    const effort = resolveSessionEffort("grok-4.6", undefined);
    expect(effort).toBe("high");
    expect(
      composePromptActionBarModelLabel({
        profile: "xai/work",
        model: "grok-4.6",
        ...(effort !== undefined ? { effort } : {}),
      }),
    ).toBe("xai/work · grok-4.6 · high");
  });

  test("shows gpt-5 medium without seeding a configured effort", () => {
    const effort = resolveSessionEffort("gpt-5", undefined);
    expect(effort).toBe("medium");
    expect(
      composePromptActionBarModelLabel({
        model: "gpt-5",
        ...(effort !== undefined ? { effort } : {}),
      }),
    ).toBe("gpt-5 · medium");
  });
});
