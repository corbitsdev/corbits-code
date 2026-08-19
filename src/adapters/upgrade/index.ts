/**
 * Soft upgrade check for interactive TUI start.
 *
 * Pure helpers detect how the running build was installed, compare the package
 * version to the latest GitHub release, and format a method-specific notice.
 * Network and detection failures never throw to callers: the check returns
 * `skipped` so startup is never blocked or errored loudly.
 */

import { basename } from "node:path";
import { existsSync } from "node:fs";

import {
  compareVersions,
  parseVersionString,
} from "../changelog/index.js";
import { COMMAND_NAME, PRODUCT_NAME } from "../../branding.js";
import pkg from "../../../package.json" with { type: "json" };

/** Public releases page (human-facing). */
export const RELEASES_URL =
  "https://github.com/corbitsdev/corbits-code/releases";

/** GitHub API endpoint for the latest published release. */
export const RELEASES_LATEST_API =
  "https://api.github.com/repos/corbitsdev/corbits-code/releases/latest";

/** Homebrew formula name (matches `scripts/release.sh` BREW_FORMULA). */
export const BREW_FORMULA = "corbits-code";

/** Debian package name (matches `scripts/release.sh` Package: field). */
export const DEB_PACKAGE = "corbits";

/** Bound the network probe so a hung API cannot stall the session. */
export const UPGRADE_FETCH_TIMEOUT_MS = 4_000;

export type InstallMethod =
  | "homebrew"
  | "deb"
  | "binary"
  | "source"
  | "unknown";

export type UpgradeNotice = {
  readonly current: string;
  readonly latest: string;
  readonly method: InstallMethod;
  readonly message: string;
};

export type UpgradeCheckResult =
  | { readonly kind: "available"; readonly notice: UpgradeNotice }
  | { readonly kind: "current" }
  | { readonly kind: "skipped"; readonly reason: string };

/** Inputs for install-method detection — injectable for tests. */
export type InstallProbe = {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly platform: NodeJS.Platform;
  /** Lowercased path string used for marker matching (realpath when available). */
  readonly resolvedPath?: string;
  readonly pathExists?: (path: string) => boolean;
  readonly env?: NodeJS.ProcessEnv;
};

export type FetchLatestVersion = () => Promise<string | null>;

export type UpgradeCheckOptions = {
  readonly currentVersion?: string;
  readonly method?: InstallMethod;
  readonly probe?: InstallProbe;
  readonly fetchLatest?: FetchLatestVersion;
};

function normalizeVersion(raw: string): string | null {
  const parsed = parseVersionString(raw);
  if (parsed === null) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * -1 if a < b, 0 if equal, 1 if a > b. Null when either side is not
 * major.minor.patch (after an optional leading `v`).
 */
export function compareVersionStrings(a: string, b: string): number | null {
  const left = parseVersionString(a);
  const right = parseVersionString(b);
  if (left === null || right === null) return null;
  return compareVersions(left, right);
}

function pathMarkers(probe: InstallProbe): string {
  const resolved = probe.resolvedPath ?? probe.execPath;
  return `${probe.execPath}\n${resolved}`.toLowerCase();
}

/**
 * Best-effort install path detection. Prefer specific package managers over
 * generic binary / source so upgrade hints match how the operator installed.
 *
 * Order matters: Bun-under-Homebrew (`/opt/homebrew/bin/bun`) is source, not
 * homebrew — only the Cellar / formula binary is a brew install of Corbits.
 */
export function detectInstallMethod(probe: InstallProbe): InstallMethod {
  const markers = pathMarkers(probe);
  const exists = probe.pathExists ?? (() => false);
  const env = probe.env ?? {};
  const execBase = basename(probe.execPath).toLowerCase();

  // Definite Homebrew formula install (Cellar layout).
  if (
    markers.includes("/cellar/corbits-code/")
    || markers.includes("/cellar/corbits/")
  ) {
    return "homebrew";
  }

  // Running under the Bun runtime (clone + `bun run start` / `bun ./dist/...`).
  // Checked before HOMEBREW_PREFIX so a brew-installed bun does not look like
  // a brew-installed corbits.
  if (execBase === "bun" || execBase === "bun.exe") {
    return "source";
  }
  const entry = probe.argv[1] ?? "";
  if (
    entry.endsWith(".ts")
    || entry.endsWith(".tsx")
    || entry.endsWith("/dist/index.js")
    || entry.endsWith("\\dist\\index.js")
  ) {
    return "source";
  }

  // Debian package installs the binary at /usr/bin/corbits and drops dpkg metadata.
  if (probe.platform === "linux") {
    if (
      exists(`/var/lib/dpkg/info/${DEB_PACKAGE}.list`)
      || exists(`/var/lib/dpkg/info/${DEB_PACKAGE}.md5sums`)
    ) {
      return "deb";
    }
    if (
      (probe.execPath === `/usr/bin/${DEB_PACKAGE}`
        || probe.resolvedPath === `/usr/bin/${DEB_PACKAGE}`
        || (execBase === DEB_PACKAGE && markers.includes("/usr/bin/")))
      && exists(`/usr/share/doc/${DEB_PACKAGE}`)
    ) {
      return "deb";
    }
  }

  // Homebrew symlink or prefix install of the corbits binary itself.
  if (execBase === COMMAND_NAME || execBase === `${COMMAND_NAME}.exe`) {
    const brewPrefix = env.HOMEBREW_PREFIX ?? env.HOMEBREW_CELLAR;
    if (
      typeof brewPrefix === "string"
      && brewPrefix.length > 0
      && markers.includes(brewPrefix.toLowerCase())
    ) {
      return "homebrew";
    }
    if (markers.includes("/homebrew/") || markers.includes("/linuxbrew/")) {
      return "homebrew";
    }
  }

  // Standalone compiled binary (GitHub release tarball or local `build:bin`).
  if (
    execBase === COMMAND_NAME
    || execBase === `${COMMAND_NAME}.exe`
  ) {
    return "binary";
  }

  return "unknown";
}

/** Method-specific upgrade guidance. Unknown never suggests brew or apt. */
export function formatUpgradeMessage(input: {
  readonly current: string;
  readonly latest: string;
  readonly method: InstallMethod;
}): string {
  const head = `Upgrade available: ${PRODUCT_NAME} v${input.current} → v${input.latest}.`;
  switch (input.method) {
    case "homebrew":
      return `${head} Run: brew update && brew upgrade ${BREW_FORMULA}`;
    case "source":
      return `${head} Pull latest, then: bun install && bun run start (or bun run build:bin)`;
    case "deb":
      return `${head} Download the .deb from ${RELEASES_URL}/latest and install with: sudo dpkg -i ${DEB_PACKAGE}_${input.latest}_*.deb`;
    case "binary":
      return `${head} Download the latest release: ${RELEASES_URL}/latest`;
    case "unknown":
      return `${head} See ${RELEASES_URL}`;
  }
}

/**
 * Probe the GitHub releases API. Returns null on any failure (offline,
 * rate-limit, malformed body, timeout) so callers can soft-skip.
 */
export async function fetchLatestReleaseVersion(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = UPGRADE_FETCH_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const res = await fetchImpl(RELEASES_LATEST_API, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": `${COMMAND_NAME}/${typeof pkg.version === "string" ? pkg.version : "0"}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (data === null || typeof data !== "object") return null;
    const tag = (data as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string") return null;
    return normalizeVersion(tag);
  } catch {
    return null;
  }
}

function defaultProbe(): InstallProbe {
  return {
    execPath: process.execPath,
    argv: process.argv,
    platform: process.platform,
    pathExists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    env: process.env,
  };
}

/**
 * Compare running version to the latest published release and, when behind,
 * return a ready-to-surface notice. Never throws.
 */
export async function checkForUpgrade(
  options: UpgradeCheckOptions = {},
): Promise<UpgradeCheckResult> {
  try {
    const currentRaw =
      options.currentVersion
      ?? (typeof pkg.version === "string" ? pkg.version : "0.0.0");
    const current = normalizeVersion(currentRaw);
    if (current === null) {
      return { kind: "skipped", reason: "unparseable current version" };
    }

    const fetchLatest =
      options.fetchLatest ?? (() => fetchLatestReleaseVersion());
    const latest = await fetchLatest();
    if (latest === null) {
      return { kind: "skipped", reason: "latest version unavailable" };
    }

    const cmp = compareVersionStrings(latest, current);
    if (cmp === null) {
      return { kind: "skipped", reason: "unparseable latest version" };
    }
    if (cmp <= 0) {
      return { kind: "current" };
    }

    const method =
      options.method
      ?? detectInstallMethod(options.probe ?? defaultProbe());
    const message = formatUpgradeMessage({ current, latest, method });
    return {
      kind: "available",
      notice: { current, latest, method, message },
    };
  } catch {
    return { kind: "skipped", reason: "upgrade check failed" };
  }
}

/**
 * Fire-and-forget startup probe: surface a notice when an upgrade is
 * available; swallow every other outcome. Safe to `void` after host mount.
 */
export function scheduleUpgradeNotice(input: {
  readonly notify: (text: string) => void;
  readonly options?: UpgradeCheckOptions;
}): void {
  void checkForUpgrade(input.options ?? {})
    .then((result) => {
      if (result.kind === "available") {
        input.notify(result.notice.message);
      }
    })
    .catch(() => {
      // Soft fail: never reject into unhandledrejection.
    });
}
