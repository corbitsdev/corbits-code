import { statSync } from "node:fs";
import { dirname, basename, resolve as resolvePath } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";

import {
  runBoundedGrep,
  runBoundedSearchFiles,
  type BoundedGrepArgs,
} from "./bounded-grep-fallback.js";
import { createRgCollector } from "./rg-output.js";
import {
  MAX_OUTPUT_BYTES,
  runRg,
  type RgLimits,
  type SpawnRg,
} from "./rg-run.js";
import { createExtraDeniedPathMatcher } from "./secret-guard-plugin.js";

// A grep over a large tree with the pure-TypeScript walker enumerates the whole
// directory (node_modules, build output, the lot) before searching, which stalls
// the loop. ripgrep prunes ignored and skipped directories during its own walk,
// so it stays fast and never surfaces gitignored content. This plugin routes
// grep/search_files through `rg` when it is installed and falls back to the
// built-in posix tool otherwise, so behavior degrades gracefully on hosts
// without ripgrep.

const DEFAULT_GREP_MAX = 500;
const DEFAULT_SEARCH_MAX = 1000;

// Dropping matches is a different fact from dropping characters, and the size
// pass below cannot infer it: a run can be well under the char cap and still
// have discarded thousands of matches. That omission is announced here; the
// size cap announces its own.
function capLines(text: string, max: number): string {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length <= max) return lines.join("\n");
  return `${lines.slice(0, max).join("\n")}\n... (showing first ${max} of ${lines.length}+ matches; narrow path/glob)`;
}

// Mirrors read_file's truncate-and-offer behavior: a cap or timeout still
// surfaces whatever matches were collected before it fired, instead of
// discarding them behind a bare error. `notice` is only set for conditions
// neither cap describes, like a run timing out.
function partialContent(
  stdout: string,
  maxResults: number,
  notice?: string,
): string {
  const capped = capLines(stdout, maxResults);
  if (capped.length === 0) {
    return notice === undefined
      ? "no matches collected"
      : `no matches collected before ${notice}`;
  }
  return notice === undefined ? capped : `${capped}\n... ${notice}`;
}

// The fallback walker collects its whole result in memory before returning, so
// the byte cap has to be applied here. Without this the cap simply does not
// exist on a host without ripgrep, and an unbounded grep reaches the model.
function boundedContent(
  content: string,
  maxResults: number,
  maxOutputBytes: number,
): string {
  const breach = createRgCollector(maxOutputBytes).push(content);
  if (breach?.kind !== "partial") return capLines(content, maxResults);
  return partialContent(breach.stdout, maxResults, breach.notice);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// rg prints paths relative to its cwd when the search target is ".", matching
// the posix tool's directory-relative output. For a single file we search from
// its parent so the printed path stays short and relative.
function searchLocation(
  path: string,
  fallbackCwd: string,
): { cwd: string; target: string } {
  try {
    const info = statSync(path);
    if (info.isDirectory()) return { cwd: path, target: "." };
    return { cwd: dirname(path), target: basename(path) };
  } catch {
    return { cwd: fallbackCwd, target: path };
  }
}

export function ripgrepPlugin(
  cwd: string,
  limits: RgLimits = {},
  spawnChild?: SpawnRg,
  // Extras-denied config paths (CL-9386, CL-1187 finding 1): the active
  // settings source, including a --config override. The secret-guard plugin
  // denies single-file grep of these paths, but a directory-scoped grep would
  // still print their matches — both the rg and fallback legs below drop
  // matches under denied paths so directory scope cannot exfiltrate them.
  // Empty by default, which keeps every existing behavior unchanged.
  extraDeniedPaths: readonly string[] = [],
): ToolPlugin {
  const maxBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const isExtraDenied = createExtraDeniedPathMatcher(extraDeniedPaths);

  // The file a `file:line:match` (or context `file-line-`) grep line came from,
  // resolved so it can be tested against the extras-denied set. Context
  // separators (`--`) and our own `...` notice lines carry no file and are
  // never matches.
  //
  // rg's separator is `:-digits-:` / `:digits:`. A non-greedy first match
  // treats `-<digits>-` inside a dated or versioned path (`2026-09-26-config.json`,
  // `gpt-4-1.json`) as the line-number field and tests the wrong prefix. Every
  // separator is a candidate so a hyphen-digit path is still extras-denied, and
  // a later `:digits:` in the match text cannot un-deny the real file.
  const grepLineDeniedFile = (line: string, rgCwd: string): boolean => {
    if (line.startsWith("...") || line === "--") return false;
    for (const match of line.matchAll(/[:-]\d+[:-]/g)) {
      const candidate = line.slice(0, match.index).replace(/^\.\//, "");
      if (candidate.length === 0) continue;
      if (isExtraDenied(resolvePath(rgCwd, candidate))) return true;
    }
    return false;
  };

  // Drop extras-denied matches from grep output (both legs). Filtering before
  // the caps keeps the "showing first N" counts honest.
  const filterGrepStdout = (stdout: string, rgCwd: string): string =>
    stdout
      .split("\n")
      .filter((line) => line.length > 0 && !grepLineDeniedFile(line, rgCwd))
      .join("\n");

  // Drop extras-denied paths from search_files output (both legs). Filtering
  // the name as well as the content: confirming the file's existence is part
  // of what the denial withholds.
  const filterSearchStdout = (stdout: string, rgCwd: string): string =>
    stdout
      .split("\n")
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("...") &&
          !isExtraDenied(resolvePath(rgCwd, line.replace(/^\.\//, ""))),
      )
      .join("\n");

  return {
    middleware: (next) => async (call, signal) => {
      if (call.name === "grep") {
        const pattern = str(call.arguments.pattern);
        if (pattern === undefined) return next(call, signal);
        const path = str(call.arguments.path) ?? cwd;
        const context = num(call.arguments.context) ?? 0;
        const glob = str(call.arguments.glob);
        const maxResults = num(call.arguments.max_results) ?? DEFAULT_GREP_MAX;
        const { cwd: rgCwd, target } = searchLocation(path, cwd);

        const rgArgs = ["--line-number", "--no-heading", "--color", "never"];
        // Per-file match cap; total output is also byte- and line-capped below.
        rgArgs.push("--max-count", String(maxResults));
        if (context > 0) rgArgs.push("-C", String(context));
        if (glob !== undefined) rgArgs.push("-g", glob);
        rgArgs.push("--regexp", pattern, target);

        const result = await runRg(rgArgs, rgCwd, signal, limits, spawnChild);
        if (result.kind === "unavailable") {
          try {
            const boundedArgs: BoundedGrepArgs = {
              pattern,
              path: target,
              context,
              max_results: maxResults,
            };
            if (glob !== undefined) boundedArgs.glob = glob;
            const content = await runBoundedGrep(boundedArgs, signal, rgCwd);
            return {
              callId: call.id,
              content: boundedContent(
                filterGrepStdout(content, rgCwd),
                maxResults,
                maxBytes,
              ),
            };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }
        if (result.kind === "no-match") {
          return { callId: call.id, content: `no matches for /${pattern}/` };
        }
        if (result.kind === "error") {
          return { callId: call.id, content: result.message, isError: true };
        }
        if (result.kind === "partial") {
          return {
            callId: call.id,
            content: partialContent(
              filterGrepStdout(result.stdout, rgCwd),
              maxResults,
              result.notice,
            ),
          };
        }
        return {
          callId: call.id,
          content: capLines(filterGrepStdout(result.stdout, rgCwd), maxResults),
        };
      }

      if (call.name === "search_files") {
        const pattern = str(call.arguments.pattern);
        if (pattern === undefined) return next(call, signal);
        const path = str(call.arguments.path) ?? cwd;
        const maxResults =
          num(call.arguments.max_results) ?? DEFAULT_SEARCH_MAX;
        const { cwd: rgCwd, target } = searchLocation(path, cwd);

        const result = await runRg(
          ["--files", "-g", pattern, target],
          rgCwd,
          signal,
          limits,
          spawnChild,
        );
        if (result.kind === "unavailable") {
          try {
            const content = await runBoundedSearchFiles(
              { pattern, path: target, max_results: maxResults },
              signal,
              rgCwd,
            );
            return {
              callId: call.id,
              content: boundedContent(
                filterSearchStdout(content, rgCwd),
                maxResults,
                maxBytes,
              ),
            };
          } catch (err) {
            return {
              callId: call.id,
              content: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }
        if (result.kind === "no-match") {
          return { callId: call.id, content: `no files matching "${pattern}"` };
        }
        if (result.kind === "error") {
          return { callId: call.id, content: result.message, isError: true };
        }
        if (result.kind === "partial") {
          return {
            callId: call.id,
            content: partialContent(
              filterSearchStdout(result.stdout, rgCwd),
              maxResults,
              result.notice,
            ),
          };
        }
        return {
          callId: call.id,
          content: capLines(
            filterSearchStdout(result.stdout, rgCwd),
            maxResults,
          ),
        };
      }

      return next(call, signal);
    },
  };
}
