import { spawnSync } from "node:child_process";

import pkg from "../package.json" with { type: "json" };

/**
 * Build-time git metadata for the version badge. Run once by `bun
 * scripts/build-info.ts` (wired into `build` and `build:bin` through
 * `--define "$(bun scripts/build-info.ts)"`); the single stdout line is the
 * define token, e.g. `process.env.CORBITS_BUILD_INFO="v0.3.36-7-g9af7e1e"`.
 *
 * A build must never fail for metadata: every field degrades to null/false
 * and the script prints a stderr warning instead of throwing.
 */

export interface GitInfo {
  tag: string | null;
  count: number | null;
  hash: string | null;
  dirty: boolean;
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

export function gitRunner(cwd: string, args: string[]): RunResult {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    stdout: typeof res.stdout === "string" ? res.stdout.trim() : "",
    exitCode: res.status ?? 1,
  };
}

function safeRun(
  run: (args: string[]) => RunResult,
  args: string[],
): RunResult | null {
  try {
    return run(args);
  } catch (err) {
    console.error(`[build-info] git ${args.join(" ")} failed: ${String(err)}`);
    return null;
  }
}

/**
 * Gathers git metadata against `cwd`. Not a git repo (or git missing) yields
 * `{ tag: null, count: null, hash: null, dirty: false }`; individual
 * failures degrade just their own field.
 */
export function collectGitInfo(
  cwd: string,
  run: (args: string[]) => RunResult = (args) => gitRunner(cwd, args),
): GitInfo {
  const inside = safeRun(run, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === null || inside.stdout !== "true") {
    return { tag: null, count: null, hash: null, dirty: false };
  }

  const tagResult = safeRun(run, [
    "describe",
    "--tags",
    "--match",
    "v*",
    "--abbrev=0",
  ]);
  const tag =
    tagResult !== null && tagResult.stdout !== "" ? tagResult.stdout : null;

  let count: number | null = null;
  if (tag !== null) {
    const countResult = safeRun(run, ["rev-list", "--count", `${tag}..HEAD`]);
    if (countResult !== null) {
      const parsed = Number.parseInt(countResult.stdout, 10);
      count = Number.isNaN(parsed) ? null : parsed;
    }
  }

  const hashResult = safeRun(run, ["rev-parse", "--short=7", "HEAD"]);
  const hash =
    hashResult !== null && hashResult.stdout !== "" ? hashResult.stdout : null;

  const diffResult = safeRun(run, ["diff-index", "--quiet", "HEAD", "--"]);
  const dirty = diffResult !== null && diffResult.exitCode === 1;

  return { tag, count, hash, dirty };
}

/**
 * Pure composition of the display version from the six SOLUTION_SCOPE §3
 * cases:
 *   on tag, clean        -> v0.3.36
 *   on tag, dirty        -> v0.3.36-dirty
 *   past tag             -> v0.3.36-7-g9af7e1e         (+ -dirty)
 *   no tags              -> v0.3.36+g9af7e1e           (+ -dirty)
 *   metadata unavailable -> v0.3.36
 */
export function composeDisplayVersion(version: string, info: GitInfo): string {
  const base = `v${version}`;
  const dirty = info.dirty ? "-dirty" : "";
  if (info.tag !== null && info.count === 0) {
    return `${base}${dirty}`;
  }
  if (
    info.tag !== null &&
    info.count !== null &&
    info.count > 0 &&
    info.hash !== null
  ) {
    return `${base}-${info.count}-g${info.hash}${dirty}`;
  }
  if (info.tag === null && info.hash !== null) {
    return `${base}+g${info.hash}${dirty}`;
  }
  return base;
}

if (import.meta.main) {
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  const display = composeDisplayVersion(version, collectGitInfo(process.cwd()));
  console.log(`process.env.CORBITS_BUILD_INFO=${JSON.stringify(display)}`);
}
