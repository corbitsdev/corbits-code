import { describe, expect, test } from "bun:test";

import {
  checkMountedRequiresTools,
  DEFAULT_KNOWN_ENGINES,
  formatCapabilityUnavailable,
  leafTierAlternatives,
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
  availableMcpTools: readonly string[] = [],
) {
  return preflightCapabilities({
    required,
    ...(resolvedFilter !== undefined ? { resolvedFilter } : {}),
    knownEngines,
    availableMcpTools,
    agentLabel: "test-worker",
  });
}

// Built-ins-only allowlist; this shape used to strip inherited Linear tools.
const ALLOW_BUILD_NO_MCP: CapabilityFilter = {
  mode: "allow",
  tools: ["read_file", "run_shell"],
};

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

  test("narrowed knownEngines reject missing_binary (test-only seam: production always passes the full catalog)", () => {
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

  test("reroute alternatives collapse aliases (shell and run_shell agree)", () => {
    expect(rerouteAlternatives("shell")).toEqual(
      rerouteAlternatives("run_shell"),
    );
    expect(rerouteAlternatives("run_shell").length).toBeGreaterThan(0);
  });

  test("reroute alternatives sort before the cap of 3 (read_file has 9 mounting directors)", () => {
    const alternatives = rerouteAlternatives("read_file");
    expect(alternatives).toEqual(["artist", "coder", "designer"]);
    expect(alternatives).toEqual([...alternatives].sort());
  });

  test("leaf reporting channel passes preflight under a narrow allowlist omitting post-filter mounts", () => {
    for (const engine of ["submit_result", "ask_director"]) {
      expect(preflight([engine], ALLOW_READ_ONLY)).toEqual({
        ok: true,
        canonical: [engine],
      });
    }
  });

  test("leafTierAlternatives names sorted Tier 3 leaf directors, never dispatch", () => {
    const alternatives = leafTierAlternatives();
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.length).toBeLessThanOrEqual(3);
    expect(alternatives).toEqual([...alternatives].sort());
    expect(alternatives).not.toContain("dispatch");
  });

  test("mounted mcp__linear__ tool passes preflight under a built-ins-only allowlist", () => {
    const result = preflight(
      ["mcp__linear__list_teams"],
      ALLOW_BUILD_NO_MCP,
      DEFAULT_KNOWN_ENGINES,
      ["mcp__linear__list_teams"],
    );
    expect(result).toEqual({
      ok: true,
      canonical: ["mcp__linear__list_teams"],
    });
  });

  test("unmounted mcp__linear__ tool rejects unknown_tool when no server is mounted", () => {
    const result = preflight(["mcp__linear__list_teams"], ALLOW_BUILD_NO_MCP);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("unknown_tool");
    expect(result.unavailable.tool).toBe("mcp__linear__list_teams");
    expect(result.unavailable.suggestion).toBeUndefined();
  });

  test("mcp__ tool from an unmounted server rejects even when other servers are mounted", () => {
    const result = preflight(
      ["mcp__nope__frobnicate"],
      ALLOW_BUILD_NO_MCP,
      DEFAULT_KNOWN_ENGINES,
      ["mcp__linear__list_teams"],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("unknown_tool");
    expect(result.unavailable.suggestion).toBeUndefined();
  });

  test("preflight grants only the named requirement, never sibling live tools", () => {
    const result = preflight(
      ["mcp__linear__list_teams"],
      ALLOW_BUILD_NO_MCP,
      DEFAULT_KNOWN_ENGINES,
      ["mcp__linear__list_teams", "mcp__linear__create_issue"],
    );
    // On-demand: the stamp covers only the requested tool, never its live sibling.
    expect(result).toEqual({
      ok: true,
      canonical: ["mcp__linear__list_teams"],
    });
  });

  test("explicit exclude naming a live MCP tool rejects permission_static", () => {
    const result = preflightCapabilities({
      required: ["mcp__linear__list_teams"],
      resolvedFilter: {
        mode: "exclude",
        tools: ["mcp__linear__list_teams"],
      },
      knownEngines: DEFAULT_KNOWN_ENGINES,
      availableMcpTools: ["mcp__linear__list_teams"],
      agentLabel: "test-worker",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.unavailable.code).toBe("permission_static");
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
        /re-dispatch|drop the requirement|correct requires_tools/i.test(action),
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

  test("missing_tool detail renders a tier fact between fact and action", () => {
    const message = formatCapabilityUnavailable(
      {
        code: "missing_tool",
        tool: "spawn_agent",
        alternatives: ["dispatch"],
        detail: 'Tier 3 leaf directors cannot mount fleet verb "spawn_agent"',
      },
      "test-worker",
    );
    expect(message.startsWith("Error:")).toBe(true);
    expect(message).toContain(
      'Tier 3 leaf directors cannot mount fleet verb "spawn_agent".',
    );
    expect(message.indexOf("Tier 3 leaf")).toBeGreaterThan(
      message.indexOf("allowlist omits it"),
    );
    expect(message.indexOf("Tier 3 leaf")).toBeLessThan(
      message.indexOf("Re-dispatch"),
    );
  });

  test("unknown_tool message carries the did-you-mean hint", () => {
    const message = formatCapabilityUnavailable(
      { code: "unknown_tool", tool: "run_shel", suggestion: "run_shell" },
      "test-worker",
    );
    expect(message).toContain('Did you mean "run_shell"?');
  });

  test("stale_snapshot message names every missing tool, not just the first", () => {
    const message = formatCapabilityUnavailable(
      {
        code: "stale_snapshot",
        tool: "run_shell",
        tools: ["run_shell", "write_file"],
      },
      "test-worker",
    );
    expect(message).toContain("stale_snapshot");
    expect(message).toContain("run_shell");
    expect(message).toContain("write_file");
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
