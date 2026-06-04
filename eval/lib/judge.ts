import { loadSettings, resolveProvider } from "../../src/settings.js";
import type { JudgeScores } from "./types.js";

// The resolved judge endpoint. Credentials come from a CL-927 settings file (on
// the secret-guard denylist), never hardcoded — so multiple judge models are
// selectable the same secure way variants are.
export type JudgeConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

export async function resolveJudge(
  configPath: string,
  provider?: string,
  model?: string,
): Promise<JudgeConfig> {
  const settings = await loadSettings(configPath);
  if (settings === null) {
    throw new Error(`Judge config not found or empty: ${configPath}`);
  }
  const cli: { provider?: string; model?: string } = {};
  if (provider !== undefined) cli.provider = provider;
  if (model !== undefined) cli.model = model;
  const resolved = resolveProvider({ settings, local: null, env: {}, cli });
  return { apiKey: resolved.apiKey, baseURL: resolved.baseURL, model: resolved.model };
}

const JUDGE_SYSTEM = [
  "You are a senior engineer reviewing a teammate's change. Score it 1-5 (5 = best) on four dimensions:",
  "- correctness: solves the task including edge cases, not just what the tests check.",
  "- scope: changed only what was needed — no over-engineering, no drive-by edits.",
  "- quality: matches conventions, no dead code, comments explain why, readable.",
  "- overall: would you merge this without rework.",
  'Reply with ONLY a JSON object: {"correctness":n,"scope":n,"quality":n,"overall":n,"rationale":"one or two sentences"}.',
].join("\n");

// Parse the judge's reply into scores. Tolerant of surrounding prose or code
// fences (extracts the first JSON object); returns null if it can't get four
// valid numeric scores rather than inventing them. Scores are clamped to 1-5.
export function parseJudgeResponse(text: string): JudgeScores | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const score = (key: string): number | null => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return Math.min(5, Math.max(1, Math.round(v)));
  };
  const correctness = score("correctness");
  const scope = score("scope");
  const quality = score("quality");
  const overall = score("overall");
  if (correctness === null || scope === null || quality === null || overall === null) {
    return null;
  }
  return {
    correctness,
    scope,
    quality,
    overall,
    rationale: typeof o.rationale === "string" ? o.rationale : "",
  };
}

function extractMessageContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}

// Score one run's diff against the task with the judge model. Returns null on any
// failure (network, non-2xx, unparseable) — the run is simply "not judged", never
// given fabricated scores.
export async function judgeRun(
  input: { task: string; diff: string; passed: boolean },
  cfg: JudgeConfig,
): Promise<JudgeScores | null> {
  const user = [
    `Task:\n${input.task}`,
    `The change (unified diff):\n${input.diff.trim().length > 0 ? input.diff : "(no changes were made)"}`,
    `The task's own tests ${input.passed ? "PASS" : "FAIL"} after the change.`,
    "Score it now as JSON only.",
  ].join("\n\n");

  // A failed judge returns null (the run is "not judged", never fabricated), but
  // log the reason — status code only, never the body or auth header — so an
  // all-"-" judge column is debuggable rather than silently broken.
  let res: Response;
  try {
    res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 512,
      }),
    });
  } catch (err) {
    warn(`judge request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!res.ok) {
    warn(`judge returned HTTP ${res.status}`);
    return null;
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    warn("judge response was not valid JSON");
    return null;
  }
  const content = extractMessageContent(data);
  if (content === null) {
    warn("judge response had no message content");
    return null;
  }
  const scores = parseJudgeResponse(content);
  if (scores === null) warn("judge response could not be parsed into scores");
  return scores;
}

function warn(message: string): void {
  // eslint-disable-next-line no-console
  console.error(`[eval judge] ${message}`);
}
