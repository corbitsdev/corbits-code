import { statSync } from "node:fs";
import { dirname, basename } from "node:path";
import type { ToolPlugin } from "@intx/tools-posix";
import type { ToolResult } from "@intx/types/runtime";

import {
  runBoundedGrep,
  runBoundedSearchFiles,
  type BoundedGrepArgs,
} from "./bounded-grep-fallback.js";
import { createRgCollector } from "./rg-output.js";
import { truncateToolResultContent } from "./result-truncation-plugin.js";
import { MAX_OUTPUT_BYTES, runRg, type RgLimits, type SpawnRg } from "./rg-run.js";

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

// ripgrepPlugin answers grep and search_files without calling next, so the
// result-truncation middleware sitting later in the chain never sees these
// results. The shared primitive is applied here instead, keeping one wording
// for size truncation on a path that would otherwise return uncapped.
function bounded(callId: string, content: string): ToolResult {
  return { callId, content: truncateToolResultContent(content) };
}

// Mirrors read_file's truncate-and-offer behavior: a cap or timeout still
// surfaces whatever matches were collected before it fired, instead of
// discarding them behind a bare error. `notice` is only set for conditions
// neither cap describes, like a run timing out.
function partialContent(stdout: string, maxResults: number, notice?: string): string {
  const capped = capLines(stdout, maxResults);
  if (capped.length === 0) {
    return notice === undefined ? "no matches collected" : `no matches collected before ${notice}`;
  }
  return notice === undefined ? capped : `${capped}\n... ${notice}`;
}

// The fallback walker collects its whole result in memory before returning, so
// the byte cap has to be applied here. Without this the cap simply does not
// exist on a host without ripgrep, and an unbounded grep reaches the model.
function boundedContent(content: string, maxResults: number, maxOutputBytes: number): string {
  const breach = createRgCollector(maxOutputBytes).push(content);
  if (breach?.kind !== "partial") return capLines(content, maxResults);
  return partialContent(breach.stdout, maxResults, breach.notice);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// rg prints paths relative to its cwd when the search target is ".", matching
// the posix tool's directory-relative output. For a single file we search from
// its parent so the printed path stays short and relative.
function searchLocation(path: string, fallbackCwd: string): { cwd: string; target: string } {
  try {
    const info = statSync(path);
    if (info.isDirectory()) return { cwd: path, target: "." };
    return { cwd: dirname(path), target: basename(path) };
  } catch {
    return { cwd: fallbackCwd, target: path };
  }
}

export function ripgrepPlugin(cwd: string, limits: RgLimits = {}, spawnChild?: SpawnRg): ToolPlugin {
  const maxBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;
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
            return bounded(call.id, boundedContent(content, maxResults, maxBytes));
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
          return bounded(call.id, partialContent(result.stdout, maxResults, result.notice));
        }
        return bounded(call.id, capLines(result.stdout, maxResults));
      }

      if (call.name === "search_files") {
        const pattern = str(call.arguments.pattern);
        if (pattern === undefined) return next(call, signal);
        const path = str(call.arguments.path) ?? cwd;
        const maxResults = num(call.arguments.max_results) ?? DEFAULT_SEARCH_MAX;
        const { cwd: rgCwd, target } = searchLocation(path, cwd);

        const result = await runRg(["--files", "-g", pattern, target], rgCwd, signal, limits);
        if (result.kind === "unavailable") {
          try {
            const content = await runBoundedSearchFiles(
              { pattern, path: target, max_results: maxResults },
              signal,
              rgCwd,
            );
            return bounded(call.id, boundedContent(content, maxResults, maxBytes));
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
          return bounded(call.id, partialContent(result.stdout, maxResults, result.notice));
        }
        return bounded(call.id, capLines(result.stdout, maxResults));
      }

      return next(call, signal);
    },
  };
}
