import { describe, expect, test } from "bun:test";

import {
  BREW_FORMULA,
  DEB_PACKAGE,
  RELEASES_URL,
  checkForUpgrade,
  compareVersionStrings,
  detectInstallMethod,
  formatUpgradeMessage,
  scheduleUpgradeNotice,
  type InstallProbe,
} from "./index.js";

function probe(partial: Partial<InstallProbe> & Pick<InstallProbe, "execPath">): InstallProbe {
  return {
    argv: [],
    platform: "darwin",
    pathExists: () => false,
    env: {},
    ...partial,
  };
}

describe("compareVersionStrings", () => {
  test("orders major.minor.patch and strips a leading v", () => {
    expect(compareVersionStrings("0.2.95", "0.2.94")).toBeGreaterThan(0);
    expect(compareVersionStrings("0.2.94", "0.2.95")).toBeLessThan(0);
    expect(compareVersionStrings("0.2.95", "0.2.95")).toBe(0);
    expect(compareVersionStrings("v0.3.0", "0.2.99")).toBeGreaterThan(0);
  });

  test("returns null for unparseable input", () => {
    expect(compareVersionStrings("not-a-version", "0.1.0")).toBeNull();
    expect(compareVersionStrings("0.1.0", "")).toBeNull();
  });
});

describe("detectInstallMethod", () => {
  test("detects Homebrew Cellar installs", () => {
    expect(
      detectInstallMethod(
        probe({
          execPath: "/opt/homebrew/Cellar/corbits-code/0.2.95/bin/corbits",
        }),
      ),
    ).toBe("homebrew");
    expect(
      detectInstallMethod(
        probe({
          execPath: "/usr/local/bin/corbits",
          resolvedPath: "/usr/local/Cellar/corbits-code/0.2.90/bin/corbits",
        }),
      ),
    ).toBe("homebrew");
  });

  test("detects legacy corbits Cellar installs", () => {
    expect(
      detectInstallMethod(
        probe({
          execPath: "/usr/local/bin/corbits",
          resolvedPath: "/usr/local/Cellar/corbits/0.2.90/bin/corbits",
        }),
      ),
    ).toBe("homebrew");
  });

  test("detects Homebrew via HOMEBREW_PREFIX when the binary lives under it", () => {
    expect(
      detectInstallMethod(
        probe({
          execPath: "/opt/homebrew/bin/corbits",
          env: { HOMEBREW_PREFIX: "/opt/homebrew" },
        }),
      ),
    ).toBe("homebrew");
  });

  test("detects Debian package installs", () => {
    expect(
      detectInstallMethod(
        probe({
          execPath: "/usr/bin/corbits",
          platform: "linux",
          pathExists: (p) => p === `/var/lib/dpkg/info/${DEB_PACKAGE}.list`,
        }),
      ),
    ).toBe("deb");
    expect(
      detectInstallMethod(
        probe({
          execPath: "/usr/bin/corbits",
          platform: "linux",
          pathExists: (p) => p === `/usr/share/doc/${DEB_PACKAGE}`,
        }),
      ),
    ).toBe("deb");
  });

  test("detects Bun / from-source runs", () => {
    expect(
      detectInstallMethod(
        probe({
          execPath: "/Users/dev/.bun/bin/bun",
          argv: ["bun", "/repo/corbits-code/src/index.ts"],
        }),
      ),
    ).toBe("source");
    expect(
      detectInstallMethod(
        probe({
          execPath: "/usr/local/bin/bun",
          argv: ["bun", "/repo/dist/index.js"],
        }),
      ),
    ).toBe("source");
    // brew-installed bun must not look like a brew-installed corbits
    expect(
      detectInstallMethod(
        probe({
          execPath: "/opt/homebrew/bin/bun",
          argv: ["bun", "/repo/src/index.ts"],
          env: { HOMEBREW_PREFIX: "/opt/homebrew" },
        }),
      ),
    ).toBe("source");
  });

  test("detects standalone release binaries", () => {
    expect(
      detectInstallMethod(
        probe({
          execPath: "/home/user/.local/bin/corbits",
          platform: "linux",
        }),
      ),
    ).toBe("binary");
    expect(
      detectInstallMethod(
        probe({
          execPath: "/Users/dev/bin/corbits",
          platform: "darwin",
        }),
      ),
    ).toBe("binary");
  });

  test("falls back to unknown rather than guessing brew", () => {
    expect(
      detectInstallMethod(
        probe({
          execPath: "/mysterious/path/agent-runner",
          argv: ["agent-runner"],
        }),
      ),
    ).toBe("unknown");
  });
});

describe("formatUpgradeMessage", () => {
  const base = { current: "0.2.90", latest: "0.2.95" };

  test("homebrew message uses the live formula upgrade", () => {
    const msg = formatUpgradeMessage({ ...base, method: "homebrew" });
    expect(msg).toContain("v0.2.90 → v0.2.95");
    expect(msg).toContain(`brew update && brew upgrade ${BREW_FORMULA}`);
    expect(msg).not.toContain("dpkg");
  });

  test("source message points at pull + bun rebuild", () => {
    const msg = formatUpgradeMessage({ ...base, method: "source" });
    expect(msg).toContain("bun install");
    expect(msg).toContain("bun run start");
    expect(msg).not.toContain("brew upgrade");
  });

  test("binary message points at the GitHub releases page", () => {
    const msg = formatUpgradeMessage({ ...base, method: "binary" });
    expect(msg).toContain(`${RELEASES_URL}/latest`);
    expect(msg).not.toContain("brew upgrade");
    expect(msg).not.toContain("dpkg");
  });

  test("deb message points at dpkg install of the release artifact", () => {
    const msg = formatUpgradeMessage({ ...base, method: "deb" });
    expect(msg).toContain("dpkg -i");
    expect(msg).toContain(`${DEB_PACKAGE}_0.2.95_`);
    expect(msg).not.toContain("brew upgrade");
  });

  test("unknown message is generic — no brew or apt command", () => {
    const msg = formatUpgradeMessage({ ...base, method: "unknown" });
    expect(msg).toContain(RELEASES_URL);
    expect(msg).not.toContain("brew");
    expect(msg).not.toContain("dpkg");
    expect(msg).not.toContain("apt");
  });
});

describe("checkForUpgrade", () => {
  test("reports available when latest is newer", async () => {
    const result = await checkForUpgrade({
      currentVersion: "0.2.90",
      method: "homebrew",
      fetchLatest: async () => "0.2.95",
    });
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.notice.current).toBe("0.2.90");
    expect(result.notice.latest).toBe("0.2.95");
    expect(result.notice.method).toBe("homebrew");
    expect(result.notice.message).toContain("brew upgrade");
  });

  test("reports current when running the latest (or newer)", async () => {
    expect(
      (
        await checkForUpgrade({
          currentVersion: "0.2.95",
          fetchLatest: async () => "0.2.95",
        })
      ).kind,
    ).toBe("current");
    expect(
      (
        await checkForUpgrade({
          currentVersion: "0.3.0",
          fetchLatest: async () => "0.2.95",
        })
      ).kind,
    ).toBe("current");
  });

  test("soft-skips when the network probe fails", async () => {
    const result = await checkForUpgrade({
      currentVersion: "0.2.90",
      fetchLatest: async () => null,
    });
    expect(result).toEqual({ kind: "skipped", reason: "latest version unavailable" });
  });

  test("soft-skips when fetchLatest throws", async () => {
    const result = await checkForUpgrade({
      currentVersion: "0.2.90",
      fetchLatest: async () => {
        throw new Error("offline");
      },
    });
    expect(result.kind).toBe("skipped");
  });

  test("detects method from probe when not forced", async () => {
    const result = await checkForUpgrade({
      currentVersion: "0.1.0",
      fetchLatest: async () => "0.2.0",
      probe: probe({
        execPath: "/Users/dev/.bun/bin/bun",
        argv: ["bun", "/repo/src/index.ts"],
      }),
    });
    expect(result.kind).toBe("available");
    if (result.kind !== "available") return;
    expect(result.notice.method).toBe("source");
    expect(result.notice.message).toContain("bun install");
  });
});

describe("scheduleUpgradeNotice", () => {
  test("notifies only when an upgrade is available", async () => {
    const notices: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    scheduleUpgradeNotice({
      notify: (text) => {
        notices.push(text);
        resolveDone();
      },
      options: {
        currentVersion: "0.1.0",
        fetchLatest: async () => "0.2.0",
        method: "homebrew",
      },
    });
    await done;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("0.2.0");
    expect(notices[0]).toContain("brew upgrade");
  });

  test("stays quiet when current or skipped", async () => {
    const notices: string[] = [];
    const fetches: Promise<string | null>[] = [];
    const track = (value: string | null) => {
      const p = Promise.resolve(value);
      fetches.push(p);
      return p;
    };
    scheduleUpgradeNotice({
      notify: (text) => notices.push(text),
      options: {
        currentVersion: "0.2.0",
        fetchLatest: () => track("0.2.0"),
      },
    });
    scheduleUpgradeNotice({
      notify: (text) => notices.push(text),
      options: {
        currentVersion: "0.1.0",
        fetchLatest: () => track(null),
      },
    });
    await Promise.all(fetches);
    await Promise.resolve();
    await Promise.resolve();
    expect(notices).toEqual([]);
  });

  test("swallows notify throws without unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let resolveFetch!: (v: string) => void;
      const fetchP = new Promise<string>((r) => {
        resolveFetch = r;
      });
      scheduleUpgradeNotice({
        notify: () => {
          throw new Error("flash failed");
        },
        options: {
          currentVersion: "0.1.0",
          fetchLatest: () => fetchP,
          method: "unknown",
        },
      });
      resolveFetch!("0.2.0");
      await fetchP;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
