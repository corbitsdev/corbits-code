import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginLoadDiagnostics,
  emitPluginWarningLog,
  formatPluginWarningsSummary,
} from "../plugins/diagnostics.js";
import {
  discoverUserPlugins,
  expandExistingPluginMembers,
  expandPluginPath,
  expandSkipDiagnosticsHandler,
  loadPluginEntry,
  type ExpandPluginPathSkip,
} from "../plugins/loader.js";
import { resolveAgentPluginProfiles } from "../plugins/agent-plugins.js";
import { resolveToolPlugins, type ToolPluginCandidate } from "../plugins/tool-plugins.js";
import { discoverSessionPlugins } from "../session/runtime-assembly.js";

// The TUI holds the alternate screen for the whole interactive session, so any
// of the real plugin-loading paths runner.ts drives at startup / enable /
// verify / add-path / tool-resolve time must never write to raw stderr — a
// bare write lands mid-frame and corrupts the rendered transcript (CL-5411).
// This instruments process.stderr.write around each real code path runner.ts
// calls (not a source grep for one function name), so it catches the bug
// class regardless of which function or file the write comes from.

async function withStderrCapture<T>(fn: () => Promise<T>): Promise<{ result: T; writes: number }> {
  const original = process.stderr.write.bind(process.stderr);
  let writes = 0;
  process.stderr.write = ((..._args: unknown[]) => {
    writes++;
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    process.stderr.write = original;
  }
}

async function makeAgentPluginWithMissingSkill(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "diag-behavior-"));
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(
    join(agentsDir, "a.md"),
    "---\nskills: [does-not-exist]\n---\nbody\n",
  );
  await writeFile(
    join(dir, "plugin.json"),
    JSON.stringify({ id: "diag-behavior", name: "diag-behavior", kind: "agent" }),
  );
  return dir;
}

describe("interactive plugin diagnostics never hit raw stderr", () => {
  test("startup discovery: a plugin with a missing skill ref stays silent on stderr", async () => {
    const pluginDir = await makeAgentPluginWithMissingSkill();
    const cwd = await mkdtemp(join(tmpdir(), "diag-cwd-"));
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      await discoverSessionPlugins({
        cwd,
        pluginPaths: [pluginDir],
        isProjectPluginTrusted: () => true,
        isRegisteredPathTrusted: () => true,
        diagnostics: diag,
      });
      emitPluginWarningLog(diag);
    });
    expect(writes).toBe(0);
  });

  test("trust-grant / enable: loading a plugin with a missing skill ref stays silent on stderr", async () => {
    const pluginDir = await makeAgentPluginWithMissingSkill();
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      await loadPluginEntry(pluginDir, { cwd: pluginDir, origin: "path", diagnostics: diag });
      // Same fold-into-message pattern the fix applies in runner.ts's
      // `saveConfig` — never a bare `emitPluginWarningSummary(diag)`.
      const message = formatPluginWarningsSummary(diag.warnings);
      expect(message).toBeDefined();
    });
    expect(writes).toBe(0);
  });

  test("verify: an agent profile that fails schema validation stays silent on stderr", async () => {
    // resolveAgentPluginProfiles validates AgentProfileSchema (requires `id`);
    // build a module with a malformed profile directly rather than round-
    // tripping through markdown, since that's the exact shape runner.ts's
    // `verify` handler passes in from an already-loaded module.
    const mod = {
      manifest: { id: "malformed-agent", name: "Malformed Agent", kind: "agent" as const },
      agentPlugin: { agents: [{ description: "missing the required id field" }] },
    };
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      const profiles = await resolveAgentPluginProfiles(
        [mod],
        { "malformed-agent": { enabled: true } },
        { diagnostics: diag },
      );
      expect(profiles).toEqual([]);
      const message = formatPluginWarningsSummary(diag.warnings);
      expect(message).toBeDefined();
    });
    expect(writes).toBe(0);
  });

  test("add-path: a marketplace with a skipped member (outside contain root) stays silent on stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "diag-market-"));
    const marketDir = join(root, "market");
    await mkdir(join(marketDir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(marketDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "demo",
        plugins: [
          // Absolute source is always skipped — same shape as a real bad entry.
          { name: "bad", source: "/etc/not-a-plugin" },
        ],
      }),
    );
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      const members = await expandPluginPath(marketDir, {
        onSkip: (skip: ExpandPluginPathSkip) => {
          diag.warnings.push(`marketplace source ${JSON.stringify(skip.source)} skipped (${skip.reason})`);
        },
      });
      expect(members).toEqual([]);
      const message = formatPluginWarningsSummary(diag.warnings);
      expect(message).toBeDefined();
    });
    expect(writes).toBe(0);
  });

  test("startup discovery: a marketplace member skipped during discovery is collected, not lost", async () => {
    // Reproduces the exact shape reported against `scanPluginsDir` /
    // `loadPluginsFromPaths`: a project-local `.corbits/plugins/` entry that
    // is itself a marketplace with one bad (absolute) `source`. Both call
    // `expandPluginPath` internally; without `onSkip` wired to `diagnostics`,
    // the skip bypasses the collector entirely (not merely misrouted to the
    // log — genuinely dropped, since nothing else observes the raw write).
    const cwd = await mkdtemp(join(tmpdir(), "diag-cwd-market-"));
    const marketDir = join(cwd, ".corbits", "plugins", "market");
    await mkdir(join(marketDir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(marketDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "demo",
        plugins: [{ name: "bad", source: "/etc/not-a-plugin" }],
      }),
    );
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      await discoverUserPlugins(cwd, { diagnostics: diag });
      // The skip must land in the collector, not just avoid stderr — a write
      // that silently vanishes without reaching diagnostics is the same
      // lost-warning bug reached by a different route.
      const message = formatPluginWarningsSummary(diag.warnings);
      expect(message).toBeDefined();
      expect(diag.warnings.some((w) => w.includes("/etc/not-a-plugin"))).toBe(true);
    });
    expect(writes).toBe(0);
  });

  test("expandExistingPluginMembers: a skipped source is dropped from the result but reaches diagnostics", async () => {
    // This is the fourth site the same bug turned up in: it wraps
    // expandPluginPath for a registered `pluginPaths` entry (runner.ts's
    // startup migration/trust-seed call), so its `onSkip` is required too —
    // there is no default to silently fall through to anymore. Dropping the
    // member from the returned list is correct (trust decisions must not
    // pre-grant a directory that could appear later), but the skip reason
    // must still surface somewhere, not vanish.
    const root = await mkdtemp(join(tmpdir(), "diag-existing-members-"));
    const marketDir = join(root, "market");
    await mkdir(join(marketDir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(marketDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "demo",
        plugins: [{ name: "bad", source: "/etc/not-a-plugin" }],
      }),
    );
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      const members = await expandExistingPluginMembers(
        marketDir,
        root,
        expandSkipDiagnosticsHandler(diag),
      );
      expect(members).toEqual([]);
      const message = formatPluginWarningsSummary(diag.warnings);
      expect(message).toBeDefined();
      expect(diag.warnings.some((w) => w.includes("/etc/not-a-plugin"))).toBe(true);
    });
    expect(writes).toBe(0);
  });

  test("startup agent-profile resolution: a malformed profile stays silent on stderr", async () => {
    // Same call shape as runner.ts's startup `resolveAgentPluginProfiles`
    // (over `executablePlugins()` and the full `settings.plugins` config),
    // distinct from the verify-time call above which targets one plugin id.
    const mod = {
      manifest: { id: "startup-agent", name: "Startup Agent", kind: "agent" as const },
      agentPlugin: { agents: [{ description: "missing the required id field" }] },
    };
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      const profiles = await resolveAgentPluginProfiles(
        [mod],
        { "startup-agent": { enabled: true } },
        { diagnostics: diag },
      );
      expect(profiles).toEqual([]);
      const message = formatPluginWarningsSummary(diag.warnings);
      expect(message).toBeDefined();
    });
    expect(writes).toBe(0);
  });

  test("tool-resolve: a throwing tool-plugin factory stays silent on stderr", async () => {
    const candidate: ToolPluginCandidate = {
      id: "throws",
      name: "Throws",
      credentials: [],
      factory: () => {
        throw new Error("boom");
      },
    };
    const { writes } = await withStderrCapture(async () => {
      const diag = createPluginLoadDiagnostics();
      const tools = await resolveToolPlugins({
        candidates: [candidate],
        pluginConfig: { throws: { enabled: true, consented: true } },
        diagnostics: diag,
      });
      expect(tools).toEqual([]);
      const message = formatPluginWarningsSummary(diag.warnings);
      expect(message).toBeDefined();
    });
    expect(writes).toBe(0);
  });
});

describe("plugin warnings route to plugin ! / /plugins, not startup notices", () => {
  test("runner does not push formatPluginWarningsSummary into startupPluginNotices", async () => {
    // Product lock: discovery / tool-plugin / profile skill-miss summaries must
    // never become fire-and-forget surfaceSystemNotice chatter. They drive
    // standingPluginWarnings → setPluginNeedsAttention + /plugins instead.
    const src = await Bun.file(new URL("./runner.ts", import.meta.url)).text();
    expect(src).toContain("standingPluginWarnings");
    expect(src).toContain("setPluginNeedsAttention");
    expect(src).not.toMatch(
      /startupPluginNotices\.push\(\s*(discoveryNotice|toolPluginNotice|profileNotice)/,
    );
    // Unverified provider-key notice is still allowed on the startup path.
    expect(src).toMatch(/startupPluginNotices\.push\([\s\S]*couldn't confirm your/);
  });
});

// The interactive paths above always hand `resolveToolPlugins` a diagnostics
// collector. Headless/standalone callers (exec's tool-plugin resolution,
// direct unit tests) may supply neither `diagnostics` nor `onWarning` —
// `resolveToolPlugins` still resolves that case, but now via its own
// explicit stderr fallback rather than delegating to
// `resolvePluginWarningHandler`'s old default. This pins that the fallback
// still fires exactly once per warning (not silently dropped) when no
// collector is in play, matching a genuinely headless call site.
describe("resolveToolPlugins without a diagnostics collector", () => {
  test("falls back to one explicit stderr write per failure", async () => {
    const candidate: ToolPluginCandidate = {
      id: "throws",
      name: "Throws",
      credentials: [],
      factory: () => {
        throw new Error("boom");
      },
    };
    const { result: tools, writes } = await withStderrCapture(async () =>
      resolveToolPlugins({
        candidates: [candidate],
        pluginConfig: { throws: { enabled: true, consented: true } },
      }),
    );
    expect(tools).toEqual([]);
    expect(writes).toBe(1);
  });
});
