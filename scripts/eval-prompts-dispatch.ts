#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemPrompt } from "@corbits/code-agent-dispatch";
import { EvalFailure, evaluate, avoids, mentions, under } from "@corbits/evals";
import type { Case, Run } from "@corbits/evals";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CASES_PATH = join(
  REPO_ROOT,
  "evals/prompts/dispatch-routing/cases.jsonl",
);
const LAST_PATH = join(REPO_ROOT, "evals/prompts/dispatch-routing/last.json");

const OLLAMA_URL = process.env.EVAL_OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.EVAL_MODEL ?? "qwen3:0.6b";

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

const routeWords = (
  run: Run<string, string, RoutingExpect>,
): readonly string[] =>
  run.expect === undefined ? ["__missing_expect__"] : [run.expect.route];

const DIY_PHRASES = [
  "I will fix",
  "I'll fix",
  "I will implement",
  "I'll implement",
  "I can fix",
  "I can implement",
  "I'll write",
  "I will write",
  "I'll do it",
  "I can do it",
  "I'll handle",
  "I will handle",
  "I'm going to implement",
] as const;

async function main(): Promise<number> {
  const cases = await loadCases(CASES_PATH);
  const report = await evaluate<string, string, RoutingExpect>(
    "dispatch-routing",
    {
      run: dispatchRoute,
      cases,
      checks: {
        routes: mentions<string, string, RoutingExpect>(routeWords),
        noDiy: avoids<string, string, RoutingExpect>(DIY_PHRASES),
        fast: under({ ms: 120_000 }),
      },
      allow: {
        routes: { miss: 6, drop: 0 },
        noDiy: { miss: 2, drop: 0 },
        fast: 0,
      },
      compare: LAST_PATH,
      save: LAST_PATH,
      about: {
        prompt: "agents/dispatch/src/prompt.ts (dispatch director)",
        model: MODEL,
        ollamaUrl: OLLAMA_URL,
      },
    },
  );
  console.log(report.markdown());
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof EvalFailure) {
      console.log(err.report.markdown());
      process.exitCode = 1;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  });
