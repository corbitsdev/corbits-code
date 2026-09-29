import { describe, expect, test } from "bun:test";

import {
  checkMountedRequiresTools,
  DEFAULT_KNOWN_ENGINES,
  formatCapabilityUnavailable,
  preflightCapabilities,
  rerouteAlternatives,
  type CapabilityUnavailable,
} from "./capability-preflight.js";
import type { CapabilityFilter } from "../agent/profile-types.js";

const ALLOW_SHELL: CapabilityFilter = {
  mode: "allow",
  tools: ["run_shell", "read_file"],
};
const ALLOW_READ_ONLY: CapabilityFilter = {
  mode: "allow",
  tools: ["read_file"],
};
const DENY_SHELL: CapabilityFilter = { mode: "exclude", tools: ["run_shell"] };

function preflight(
  required: readonly string[],
  resolvedFilter?: CapabilityFilter,
  knownEngines: readonly string[] = DEFAULT_KNOWN_ENGINES,
) {
  return preflightCapabilities({
    required,
    ...(resolvedFilter !== undefined ? { resolvedFilter } : {}),
    knownEngines,
    agentLabel: "test-worker",
  });
}

describe("preflightCapabilities", () => {
  test("allow filter mounting the tool passes and returns canonical names", () => {
    const result = preflight(["run_shell"], ALLOW_SHELL);
    expect(result).toEqual({ ok: true, canonical: ["run_shell"] });
  });

  test("exclude filter omitting the tool passes", () => {
    const result = preflight(["read_file"], DENY_SHELL);
    expect(result).toEqual({ ok: true, canonical: ["read_file"] });
  });

  test("undefined filter is a full mount — every known tool passes", () => {
    const result = preflight(["run_shell", "web_fetch", "manage_tasks"]);
    expect(result).toEqual({
      ok: true,
      canonical: ["run_shell", "web_fetch", "manage_tasks"],
    });
  });

  test("aliases collapse on both sides (shell requirement vs run_shell filter)", () => {
    const result = preflight(["shell"], ALLOW_SHELL);
    expect(result).toEqual({ ok: true, canonical: ["run_shell"] });
  });

  test("allowlist omission rejects missing_tool with reroute alternatives", () => {
    const result = preflight(["run_shell"], ALLOW_READ_ONLY);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("missing_tool");
    expect(result.unavailable.tool).toBe("run_shell");
    expect(result.unavailable.alternatives?.length ?? 0).toBeGreaterThan(0);
  });

  test("denylist hit rejects permission_static", () => {
    const result = preflight(["run_shell"], DENY_SHELL);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("permission_static");
    expect(result.unavailable.tool).toBe("run_shell");
  });

  test("known tool with an absent binary rejects missing_binary", () => {
    const result = preflight(["run_shell"], ALLOW_SHELL, []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("missing_binary");
  });

  test("post-filter mounted engines bypass a narrow allowlist", () => {
    const result = preflight(["manage_tasks"], ALLOW_READ_ONLY);
    expect(result).toEqual({ ok: true, canonical: ["manage_tasks"] });
  });

  test("unknown tool rejects with a nearest-name suggestion", () => {
    const result = preflight(["run_shel"], ALLOW_SHELL);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("unknown_tool");
    expect(result.unavailable.tool).toBe("run_shel");
    expect(result.unavailable.suggestion).toBe("run_shell");
  });

  test("malformed profile source fails closed before per-tool checks", () => {
    const result = preflightCapabilities({
      required: ["read_file"],
      resolvedFilter: ALLOW_SHELL,
      knownEngines: DEFAULT_KNOWN_ENGINES,
      agentLabel: "test-worker",
      profileSource: {
        malformed: true,
        path: "/agents/broken.json",
        reason: "unexpected token at line 3",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("malformed_profile");
  });

  test("reroute alternatives collapse aliases (shell and run_shell agree)", () => {
    expect(rerouteAlternatives("shell")).toEqual(
      rerouteAlternatives("run_shell"),
    );
    expect(rerouteAlternatives("run_shell").length).toBeGreaterThan(0);
  });
});

describe("formatCapabilityUnavailable", () => {
  const cases: {
    code: CapabilityUnavailable["code"];
    unavailable: CapabilityUnavailable;
  }[] = [
    {
      code: "missing_tool",
      unavailable: {
        code: "missing_tool",
        tool: "run_shell",
        alternatives: ["builder"],
      },
    },
    {
      code: "permission_static",
      unavailable: {
        code: "permission_static",
        tool: "run_shell",
        alternatives: ["builder"],
      },
    },
    {
      code: "missing_binary",
      unavailable: { code: "missing_binary", tool: "run_shell" },
    },
    {
      code: "stale_snapshot",
      unavailable: { code: "stale_snapshot", tool: "run_shell" },
    },
    {
      code: "malformed_profile",
      unavailable: {
        code: "malformed_profile",
        tool: "/agents/broken.json",
        suggestion: "unexpected token at line 3",
      },
    },
    {
      code: "unknown_tool",
      unavailable: {
        code: "unknown_tool",
        tool: "run_shel",
        suggestion: "run_shell",
      },
    },
  ];

  for (const { code, unavailable } of cases) {
    test(`${code} message starts with Error, names the tool, and ends in one action sentence`, () => {
      const message = formatCapabilityUnavailable(unavailable, "test-worker");
      expect(message.startsWith("Error:")).toBe(true);
      expect(message).toContain(unavailable.tool);
      expect(message.endsWith(".")).toBe(true);
      const sentences = message
        .split(/(?<=\.) /)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // Fact sentence(s) plus exactly one trailing next-action sentence.
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      const action = sentences[sentences.length - 1] ?? "";
      expect(
        /re-dispatch|drop the requirement|install the backing runtime|fix the profile|correct requires_tools/i.test(
          action,
        ),
      ).toBe(true);
    });
  }

  test("stale_snapshot message carries setup_error and non-continuable, never a retry affordance", () => {
    const message = formatCapabilityUnavailable(
      { code: "stale_snapshot", tool: "run_shell" },
      "test-worker",
    );
    expect(message).toContain("stale_snapshot");
    expect(message).toContain("setup_error");
    expect(message).toContain("non-continuable");
    expect(message.toLowerCase()).toContain("instead of retrying");
    expect(message.toLowerCase()).not.toContain("auto-retry");
    expect(message).not.toContain("successor");
    expect(message).not.toContain('continuable": true');
  });

  test("missing_tool message names the reroute target", () => {
    const alternatives = rerouteAlternatives("run_shell");
    const message = formatCapabilityUnavailable(
      { code: "missing_tool", tool: "run_shell", alternatives },
      "test-worker",
    );
    expect(message).toContain(alternatives[0] ?? "");
  });

  test("unknown_tool message carries the did-you-mean hint", () => {
    const message = formatCapabilityUnavailable(
      { code: "unknown_tool", tool: "run_shel", suggestion: "run_shell" },
      "test-worker",
    );
    expect(message).toContain('Did you mean "run_shell"?');
  });
});

describe("checkMountedRequiresTools", () => {
  test("stamped tool missing from the live mount reports stale", () => {
    expect(checkMountedRequiresTools(["run_shell"], ["read_file"])).toEqual({
      ok: false,
      missing: ["run_shell"],
    });
  });

  test("mounted tools pass, collapsing aliases", () => {
    expect(checkMountedRequiresTools(["shell"], ["run_shell"])).toEqual({
      ok: true,
    });
  });

  test("empty requirements always pass", () => {
    expect(checkMountedRequiresTools([], [])).toEqual({ ok: true });
  });
});
