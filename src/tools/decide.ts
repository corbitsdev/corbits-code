import { type } from "arktype";
import { stringTool } from "@intx/agent";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

// Typed decisions over a JSON state via TypeSafe's Jev model (see
// plugins/corbits-skills/skills/corbits-system-one/SKILL.md). Jev never
// generates text: one POST carries every question and each answer comes back
// as a typed decision the caller branches on in code.

export const DECIDE_TOOL_NAME = "decide";
// Matches the @corbits/system-one default: decisions are gut-checks, so a
// short budget keeps a slow gate from stalling the agent loop.
export const DECIDE_DEFAULT_TIMEOUT_MS = 1500;
export const DECIDE_MAX_TIMEOUT_MS = 30_000;
export const DECIDE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DECIDE_MODEL = "jev-latest";

export const decideDefinition: ToolDefinition = {
  name: DECIDE_TOOL_NAME,
  description:
    "Ask Jev for fast typed decisions (choice, score, yes/no) over a JSON state. " +
    "Returns one validated decision per question id plus latencyMs. " +
    "This tool never generates text: do not use it for open-ended generation or tool-calling loops. " +
    "On fallback (no key, timeout, network, http, or parse error) the result is marked fallback:true — " +
    "fail closed: do not proceed on a default, retry, escalate, or ask the operator instead.",
  inputSchema: {
    type: "object",
    properties: {
      state: {
        type: "object",
        description:
          "JSON state the questions are evaluated against (DIY vs spawn vs specialist routing, gating, triage).",
      },
      questions: {
        type: "array",
        description:
          "Questions to evaluate in one round trip. One POST carries every question, so ask all of them at once.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Unique id; decisions come back under the same id.",
            },
            type: {
              type: "string",
              enum: ["choice", "score", "boolean", "noul"],
              description:
                "choice: pick one option; score: rate on ordered levels; boolean/noul: probability the answer is yes.",
            },
            instructions: {
              type: "string",
              description: "The single well-scoped judgment to make.",
            },
            criteria: {
              description:
                "choice: map of option name to description (2+ options). score: 2 to 10 ordered level descriptions. boolean/noul: optional map of true/false descriptions.",
            },
          },
          required: ["id", "type", "instructions"],
        },
      },
      timeoutMs: {
        type: "number",
        description: `Timeout in ms (default ${DECIDE_DEFAULT_TIMEOUT_MS}, max ${DECIDE_MAX_TIMEOUT_MS}).`,
      },
    },
    required: ["state", "questions"],
  },
};

const DecideQuestionSchema = type({
  id: "string>0",
  type: "'choice' | 'score' | 'boolean' | 'noul'",
  instructions: "string>0",
  "criteria?": "Record<string, string> | string[]",
});

const DecideArgsSchema = type({
  state: "Record<string, unknown> | string",
  questions: DecideQuestionSchema.array(),
  "timeoutMs?": "number",
});

export type DecideQuestionType = "choice" | "score" | "boolean" | "noul";

export interface DecideQuestionInput {
  id: string;
  type: DecideQuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface DecideDecision {
  id: string;
  [key: string]: unknown;
}

export type DecideFallbackReason =
  | "no-key"
  | "timeout"
  | "network"
  | "http-error"
  | "parse-error";

export type DecideEvaluateResult =
  | {
      ok: true;
      decisions: DecideDecision[];
      latencyMs: number;
      usage?: unknown;
    }
  | {
      ok: false;
      fallback: true;
      reason: DecideFallbackReason;
      detail: string;
      latencyMs: number;
    };

export interface DecideEvaluateRequest {
  state: Record<string, unknown> | string;
  questions: DecideQuestionInput[];
  timeoutMs: number;
}

export type DecideEvaluator = (
  request: DecideEvaluateRequest,
) => Promise<DecideEvaluateResult>;

export interface DecideToolDeps {
  evaluate?: DecideEvaluator;
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
}

// Off by default: the profile decide flag (CL-9880) does not exist yet, so
// the settings boolean is the gate. Structural param keeps this import-free
// of the settings module.
export function isDecideEnabled(
  settings: { decideEnabled?: boolean } | undefined,
): boolean {
  return settings?.decideEnabled === true;
}

function resolveApiKey(env: NodeJS.ProcessEnv): string | undefined {
  // SYSTEM_ONE_API_KEY is the alias; it works on every endpoint.
  for (const name of [
    "SYSTEM_ONE_API_KEY",
    "TYPESAFE_API_KEY",
    "AI_GATEWAY_API_KEY",
  ]) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

// The upstream API takes questions as a map keyed by caller-chosen id;
// `boolean` is our alias for the wire `noul` type.
function toWireQuestions(
  questions: DecideQuestionInput[],
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const question of questions) {
    mapped[question.id] = {
      type: question.type === "boolean" ? "noul" : question.type,
      instructions: question.instructions,
      ...(question.criteria !== undefined
        ? { criteria: question.criteria }
        : {}),
    };
  }
  return mapped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDefaultDecideEvaluator(deps?: {
  env?: NodeJS.ProcessEnv;
  endpoint?: string;
}): DecideEvaluator {
  const env = deps?.env ?? process.env;
  const endpoint = deps?.endpoint ?? DECIDE_ENDPOINT;
  return async (request) => {
    const apiKey = resolveApiKey(env);
    const startedAt = Date.now();
    if (apiKey === undefined) {
      return {
        ok: false,
        fallback: true,
        reason: "no-key",
        detail:
          "No API key: set TYPESAFE_API_KEY (or SYSTEM_ONE_API_KEY as an alias).",
        latencyMs: 0,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: request.state,
          model: DECIDE_MODEL,
          questions: toWireQuestions(request.questions),
        }),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          ok: false,
          fallback: true,
          reason: "http-error",
          detail: `TypeSafe endpoint answered with status ${response.status}.`,
          latencyMs,
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          ok: false,
          fallback: true,
          reason: "parse-error",
          detail: "TypeSafe endpoint returned a non-JSON body.",
          latencyMs,
        };
      }
      if (!isRecord(body) || !isRecord(body.answers)) {
        return {
          ok: false,
          fallback: true,
          reason: "parse-error",
          detail: "TypeSafe endpoint returned no answers map.",
          latencyMs,
        };
      }
      const decisions: DecideDecision[] = [];
      for (const question of request.questions) {
        const answer = body.answers[question.id];
        if (!isRecord(answer)) {
          return {
            ok: false,
            fallback: true,
            reason: "parse-error",
            detail: `TypeSafe endpoint returned no answer for question "${question.id}".`,
            latencyMs,
          };
        }
        decisions.push({ id: question.id, ...answer });
      }
      const latencyTotalMs = Date.now() - startedAt;
      return {
        ok: true,
        decisions,
        latencyMs: latencyTotalMs,
        ...(isRecord(body.usage) ? { usage: body.usage } : {}),
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          fallback: true,
          reason: "timeout",
          detail: `TypeSafe request timed out after ${request.timeoutMs}ms.`,
          latencyMs,
        };
      }
      return {
        ok: false,
        fallback: true,
        reason: "network",
        detail: `TypeSafe request failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

function validateQuestions(
  questions: DecideQuestionInput[],
): string | undefined {
  if (questions.length === 0) {
    return "Error: decide requires at least one question.";
  }
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) {
      return `Error: decide question ids must be unique (duplicate "${question.id}").`;
    }
    seen.add(question.id);
    if (question.type === "choice") {
      if (
        !isRecord(question.criteria) ||
        Object.keys(question.criteria).length < 2
      ) {
        return `Error: decide choice question "${question.id}" requires criteria with at least two named options.`;
      }
    } else if (question.type === "score") {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        question.criteria.length > 10
      ) {
        return `Error: decide score question "${question.id}" requires criteria with 2 to 10 ordered level descriptions.`;
      }
    } else if (
      question.criteria !== undefined &&
      !isRecord(question.criteria)
    ) {
      return `Error: decide boolean/noul question "${question.id}" accepts only an optional true/false criteria map.`;
    }
  }
  return undefined;
}

function failClosedBody(
  result: Extract<DecideEvaluateResult, { ok: false }>,
): string {
  return JSON.stringify({
    fallback: true,
    reason: result.reason,
    latencyMs: result.latencyMs,
    error:
      `Fail closed: decide fell back (${result.reason}: ${result.detail}). ` +
      "Do not proceed on a default decision — retry the call, escalate, or ask the operator.",
  });
}

export function createDecideTool(deps?: DecideToolDeps): AgentTool {
  const evaluate =
    deps?.evaluate ??
    createDefaultDecideEvaluator({
      ...(deps?.env !== undefined ? { env: deps.env } : {}),
      ...(deps?.endpoint !== undefined ? { endpoint: deps.endpoint } : {}),
    });
  return stringTool({
    definition: decideDefinition,
    handler: async (
      rawArgs: Record<string, unknown>,
      _signal: AbortSignal,
    ): Promise<string> => {
      const parsed = DecideArgsSchema(rawArgs);
      if (parsed instanceof type.errors) {
        return "Error: decide requires a JSON state plus questions with unique ids (id, type choice|score|boolean|noul, instructions, and criteria for choice/score).";
      }
      const questions = parsed.questions as DecideQuestionInput[];
      const invalid = validateQuestions(questions);
      if (invalid !== undefined) return invalid;
      const timeoutMs =
        parsed.timeoutMs !== undefined &&
        Number.isFinite(parsed.timeoutMs) &&
        parsed.timeoutMs > 0
          ? Math.min(parsed.timeoutMs, DECIDE_MAX_TIMEOUT_MS)
          : DECIDE_DEFAULT_TIMEOUT_MS;
      const result = await evaluate({
        state: parsed.state,
        questions,
        timeoutMs,
      });
      if (!result.ok) return failClosedBody(result);
      return JSON.stringify({
        fallback: false,
        decisions: result.decisions,
        latencyMs: result.latencyMs,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      });
    },
  });
}
