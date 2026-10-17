#!/usr/bin/env bun
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemPrompt } from "@corbits/code-agent-dispatch";
import { EvalFailure, evaluate, under } from "@corbits/evals";
import type {
  Case,
  CheckValue,
  EvaluateOptions,
  Report,
  Run,
} from "@corbits/evals";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CASES_PATH = join(
  REPO_ROOT,
  "evals/prompts/dispatch-routing/cases.jsonl",
);
const LAST_PATH = join(REPO_ROOT, "evals/prompts/dispatch-routing/last.json");
const BASELINE_PATH = join(
  REPO_ROOT,
  "evals/prompts/dispatch-routing/baseline.json",
);

const OLLAMA_URL = process.env.EVAL_OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.EVAL_MODEL ?? "qwen3:0.6b";

export const ROUTE_BUDGET_MS = 120_000;

const REPLY_FORMAT = `\n\n# Reply format
Reply with exactly one line: the specialist you would spawn, one of: explorer, planner, coder, reviewer, designer, artist, warden, shakespeare, prober, qa-lead. Then a second line with a one-sentence brief.`;

async function dispatchRoute(
  input: string,
  signal: AbortSignal,
): Promise<string> {
  const prompt = `${systemPrompt.build()}\n\n# Request\n${input}${REPLY_FORMAT}`;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: prompt }],
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) {
    throw new Error(`model call failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as {
    message?: { content?: string };
    error?: string;
  };
  if (data.error !== undefined) {
    throw new Error(`model call failed: ${data.error}`);
  }
  const reply = data.message?.content?.trim() ?? "";
  if (reply === "") {
    throw new Error("model returned an empty reply");
  }
  return reply;
}

interface RoutingExpect {
  route: string;
  decoys: readonly string[];
}

function loadCases(path: string): Promise<Case<string, RoutingExpect>[]> {
  return readFile(path, "utf8").then((text) => {
    const cases: Case<string, RoutingExpect>[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (line === undefined || line === "") {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (cause) {
        throw new Error(
          `${path}:${i + 1}: invalid JSON (${(cause as Error).message})`,
        );
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`${path}:${i + 1}: expected an object`);
      }
      const rec = raw as Record<string, unknown>;
      const input = rec["input"];
      if (typeof input !== "string") {
        throw new Error(`${path}:${i + 1}: missing string "input"`);
      }
      const expect = rec["expect"];
      if (
        typeof expect !== "object" ||
        expect === null ||
        Array.isArray(expect)
      ) {
        throw new Error(`${path}:${i + 1}: missing object "expect"`);
      }
      const exp = expect as Record<string, unknown>;
      const route = exp["route"];
      const decoys = exp["decoys"];
      if (
        typeof route !== "string" ||
        !Array.isArray(decoys) ||
        !decoys.every((d) => typeof d === "string")
      ) {
        throw new Error(
          `${path}:${i + 1}: expect needs string "route" and string[] "decoys"`,
        );
      }
      const evalCase: Case<string, RoutingExpect> = {
        input,
        expect: { route, decoys: decoys as string[] },
      };
      const name = rec["name"];
      if (typeof name === "string" && name !== "") {
        evalCase.name = name;
      }
      cases.push(evalCase);
    }
    if (cases.length === 0) {
      throw new Error(`${path}: no cases`);
    }
    return cases;
  });
}

function routeLine(output: string): string {
  const line = output.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

function chosenRoute(output: string): string {
  return routeLine(output).toLowerCase();
}

export function routesCheck(
  run: Run<string, string, RoutingExpect>,
): CheckValue {
  const expected = run.expect;
  if (expected === undefined) {
    return { pass: false, value: 0, explanation: "case has no expect" };
  }
  const chosen = chosenRoute(run.output);
  const route = expected.route.trim().toLowerCase();
  const decoys = expected.decoys.map((decoy) => decoy.trim().toLowerCase());
  if (decoys.includes(chosen)) {
    return { pass: false, value: 0, explanation: `decoy route: ${chosen}` };
  }
  if (chosen !== route) {
    return {
      pass: false,
      value: 0,
      explanation: `expected ${route}, got ${chosen === "" ? "(empty)" : chosen}`,
    };
  }
  return true;
}

const DISPATCH_EVAL = "dispatch-routing";

type DispatchEvaluate = (
  name: string,
  options: EvaluateOptions<string, string, RoutingExpect>,
) => Promise<Report<string, string, RoutingExpect>>;

interface StoredCheck {
  pass: boolean;
  value: number;
}

interface StoredRun {
  format: 1;
  eval: string;
  about?: Record<string, unknown>;
  cases: Record<string, Record<string, StoredCheck>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredRun(text: string, source: string): StoredRun {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source}: invalid JSON (${(cause as Error).message})`);
  }
  if (!isRecord(raw) || !isRecord(raw["cases"])) {
    throw new Error(`${source}: expected a stored run`);
  }
  const format = raw["format"];
  const evalName = raw["eval"];
  if (format !== 1 || typeof evalName !== "string" || evalName === "") {
    throw new Error(`${source}: expected a format 1 stored run`);
  }
  const cases: Record<string, Record<string, StoredCheck>> = {};
  for (const [name, checks] of Object.entries(raw["cases"])) {
    if (!isRecord(checks)) {
      throw new Error(`${source}: case "${name}" must be an object`);
    }
    const parsed: Record<string, StoredCheck> = {};
    for (const [check, outcome] of Object.entries(checks)) {
      if (
        !isRecord(outcome) ||
        typeof outcome["pass"] !== "boolean" ||
        typeof outcome["value"] !== "number" ||
        !Number.isFinite(outcome["value"])
      ) {
        throw new Error(
          `${source}: case "${name}" check "${check}" is invalid`,
        );
      }
      parsed[check] = { pass: outcome["pass"], value: outcome["value"] };
    }
    cases[name] = parsed;
  }
  const stored: StoredRun = { format: 1, eval: evalName, cases };
  if (isRecord(raw["about"])) {
    stored.about = raw["about"];
  }
  return stored;
}

function routesStoredPass(
  checks: Record<string, StoredCheck> | undefined,
): boolean {
  return checks?.["routes"]?.pass === true;
}

async function baselinePresent(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// A miss is a drop only when the stored routes pass is true, so the miss
// budget would keep a case that has never been baselined green. Passes still
// merge: a miss is never written as a pass, and a stored pass is never
// replaced by a miss, so a later flip of a case that passed beside a sibling
// miss is a drop.
async function commitRoutingBaseline(args: {
  hadBaseline: boolean;
  lastPath: string;
  baselinePath: string;
}): Promise<number> {
  const last = parseStoredRun(
    await readFile(args.lastPath, "utf8"),
    args.lastPath,
  );
  const missed = Object.entries(last.cases).filter(
    ([, checks]) => !routesStoredPass(checks),
  );
  if (missed.length === 0) {
    await copyFile(args.lastPath, args.baselinePath);
    return 0;
  }
  if (!args.hadBaseline) {
    console.error(
      `eval "${DISPATCH_EVAL}" failed: no baseline at ${args.baselinePath}`,
    );
    return 1;
  }
  const beforeText = await readFile(args.baselinePath, "utf8");
  const baseline = parseStoredRun(beforeText, args.baselinePath);
  const unbaselined = missed
    .filter(([name]) => baseline.cases[name] === undefined)
    .map(([name]) => name);
  const cases = { ...baseline.cases };
  let changed = false;
  for (const [name, checks] of Object.entries(last.cases)) {
    if (!routesStoredPass(checks)) continue;
    if (routesStoredPass(cases[name])) continue;
    cases[name] = checks;
    changed = true;
  }
  if (changed) {
    const next: StoredRun = { ...baseline, cases };
    await writeFile(args.baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  }
  if (unbaselined.length !== 0) {
    console.error(
      `eval "${DISPATCH_EVAL}" failed: unbaselined routes miss (${unbaselined.join(", ")})`,
    );
    return 1;
  }
  return 0;
}

export async function evaluateRouting(args: {
  cases: readonly Case<string, RoutingExpect>[];
  run: (input: string, signal: AbortSignal) => Promise<string>;
  lastPath: string;
  baselinePath: string;
  evaluateFn?: DispatchEvaluate;
}): Promise<number> {
  const hadBaseline = await baselinePresent(args.baselinePath);
  const evaluateFn: DispatchEvaluate =
    args.evaluateFn ?? ((name, options) => evaluate(name, options));
  try {
    const report = await evaluateFn(DISPATCH_EVAL, {
      run: args.run,
      cases: args.cases,
      checks: {
        routes: routesCheck,
        fast: under({ ms: ROUTE_BUDGET_MS }),
      },
      allow: {
        routes: { miss: 6, drop: 0 },
        fast: 0,
      },
      compare: args.baselinePath,
      save: args.lastPath,
      timeout: ROUTE_BUDGET_MS,
      about: {
        prompt: "agents/dispatch/src/prompt.ts (dispatch director)",
        model: MODEL,
        ollamaUrl: OLLAMA_URL,
      },
    });
    console.log(report.markdown());
    return await commitRoutingBaseline({
      hadBaseline,
      lastPath: args.lastPath,
      baselinePath: args.baselinePath,
    });
  } catch (err: unknown) {
    if (err instanceof EvalFailure) {
      console.log(err.report.markdown());
      return 1;
    }
    throw err;
  }
}

async function main(): Promise<number> {
  const cases = await loadCases(CASES_PATH);
  return evaluateRouting({
    cases,
    run: dispatchRoute,
    lastPath: LAST_PATH,
    baselinePath: BASELINE_PATH,
  });
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
}
