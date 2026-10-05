// Local Ollama SystemOne evaluator seam (CL-9925).
//
// Standalone on purpose: the decide tool (CL-9883, PR #1331, src/tools/decide.ts)
// is not merged yet, so there is no validateDecisionAnswer to reuse. The types
// and answer-validation below intentionally mirror that unmerged seam; when
// #1331 lands, the decide tool can accept this factory as its `evaluate` dep
// without changing its TYPESAFE default.
//
// Do NOT implement this on top of the chat adapter: the local clef-flash model
// rejects /api/chat and /api/generate. The only supported path is a single
// POST to {rootURL}/v1/systemone carrying { model, state, questions }.
// One call, one backend: this evaluator never mixes TYPESAFE and Ollama in a
// single evaluation.

export const OLLAMA_SYSTEMONE_PATH = "/v1/systemone";
export const OLLAMA_DECIDE_DEFAULT_TIMEOUT_MS = 1500;
export const OLLAMA_DECIDE_MAX_TIMEOUT_MS = 30_000;

export type OllamaDecideQuestionType = "choice" | "score" | "boolean" | "noul";

export interface OllamaDecideQuestion {
  id: string;
  type: OllamaDecideQuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface OllamaDecideDecision {
  id: string;
  [key: string]: unknown;
}

export type OllamaDecideFallbackReason =
  | "timeout"
  | "network"
  | "http-error"
  | "parse-error";

export type OllamaDecideEvaluateResult =
  | {
      ok: true;
      decisions: OllamaDecideDecision[];
      latencyMs: number;
      usage?: unknown;
    }
  | {
      ok: false;
      fallback: true;
      reason: OllamaDecideFallbackReason;
      detail: string;
      latencyMs: number;
    };

export interface OllamaDecideEvaluateRequest {
  state: Record<string, unknown> | string;
  questions: OllamaDecideQuestion[];
  timeoutMs?: number;
}

export type OllamaSystemOneEvaluator = (
  request: OllamaDecideEvaluateRequest,
) => Promise<OllamaDecideEvaluateResult>;

export interface OllamaSystemOneEvaluatorDeps {
  rootURL: string;
  model: string;
  fetchFn?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mirrors validateDecisionAnswer in the unmerged decide.ts: choice must be a
// declared option, score an in-range integer index, noul a 0-1 probability
// (boolean questions also accept a boolean field).
function validateOllamaAnswer(
  question: OllamaDecideQuestion,
  answer: Record<string, unknown>,
): string | undefined {
  if (question.type === "choice") {
    if (!isRecord(question.criteria)) {
      return `Ollama endpoint returned a choice answer for question "${question.id}" without choice criteria.`;
    }
    const options = Object.keys(question.criteria);
    if (typeof answer.choice !== "string" || !options.includes(answer.choice)) {
      return `Ollama endpoint returned unknown choice for question "${question.id}".`;
    }
    return undefined;
  }
  if (question.type === "score") {
    if (!Array.isArray(question.criteria)) {
      return `Ollama endpoint returned a score answer for question "${question.id}" without score criteria.`;
    }
    if (
      typeof answer.score !== "number" ||
      !Number.isInteger(answer.score) ||
      answer.score < 0 ||
      answer.score >= question.criteria.length
    ) {
      return `Ollama endpoint returned out-of-range score for question "${question.id}".`;
    }
    return undefined;
  }
  const noul = answer.noul;
  if (typeof noul === "number") {
    if (!Number.isFinite(noul) || noul < 0 || noul > 1) {
      return `Ollama endpoint returned out-of-range noul for question "${question.id}".`;
    }
    return undefined;
  }
  if (question.type === "boolean" && typeof answer.boolean === "boolean") {
    return undefined;
  }
  return `Ollama endpoint returned a malformed yes/no answer for question "${question.id}".`;
}

// The upstream API takes questions as a map keyed by caller-chosen id;
// `boolean` is our alias for the wire `noul` type.
function toWireQuestions(
  questions: OllamaDecideQuestion[],
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

export function createOllamaSystemOneEvaluator(
  deps: OllamaSystemOneEvaluatorDeps,
): OllamaSystemOneEvaluator {
  const rootURL = deps.rootURL.replace(/\/+$/, "");
  const model = deps.model;
  const fetchFn = deps.fetchFn ?? fetch;
  return async (request) => {
    const timeoutMs =
      request.timeoutMs !== undefined &&
      Number.isFinite(request.timeoutMs) &&
      request.timeoutMs > 0
        ? Math.min(request.timeoutMs, OLLAMA_DECIDE_MAX_TIMEOUT_MS)
        : OLLAMA_DECIDE_DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${rootURL}${OLLAMA_SYSTEMONE_PATH}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          state: request.state,
          questions: toWireQuestions(request.questions),
        }),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return {
          ok: false,
          fallback: true,
          reason: "http-error",
          detail: `Ollama endpoint answered with status ${response.status}.`,
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
          detail: "Ollama endpoint returned a non-JSON body.",
          latencyMs,
        };
      }
      if (!isRecord(body) || !isRecord(body.answers)) {
        return {
          ok: false,
          fallback: true,
          reason: "parse-error",
          detail: "Ollama endpoint returned no answers map.",
          latencyMs,
        };
      }
      const decisions: OllamaDecideDecision[] = [];
      for (const question of request.questions) {
        const answer = body.answers[question.id];
        if (!isRecord(answer)) {
          return {
            ok: false,
            fallback: true,
            reason: "parse-error",
            detail: `Ollama endpoint returned no answer for question "${question.id}".`,
            latencyMs,
          };
        }
        const invalid = validateOllamaAnswer(question, answer);
        if (invalid !== undefined) {
          return {
            ok: false,
            fallback: true,
            reason: "parse-error",
            detail: invalid,
            latencyMs,
          };
        }
        decisions.push({ id: question.id, ...answer });
      }
      return {
        ok: true,
        decisions,
        latencyMs: Date.now() - startedAt,
        ...(isRecord(body.usage) ? { usage: body.usage } : {}),
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          fallback: true,
          reason: "timeout",
          detail: `Ollama request timed out after ${timeoutMs}ms.`,
          latencyMs,
        };
      }
      return {
        ok: false,
        fallback: true,
        reason: "network",
        detail: `Ollama request failed: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
