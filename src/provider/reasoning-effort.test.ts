import { afterEach, describe, test, expect } from "bun:test";
import {
  REASONING_EFFORTS,
  ROLE_DEFAULT_EFFORT,
  isReasoningEffort,
  supportedEfforts,
  validateEffort,
  setModelReasoningCapabilities,
  modelReasoningCapability,
  clampEffort,
  pickEffortFromCascade,
  resolveEffortForRole,
} from "./reasoning-effort.js";

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
