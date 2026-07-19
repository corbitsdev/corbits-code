import { type } from "arktype";
import { runInference, type Dependencies } from "@intx/inference";
import type { ConversationTurn, InferenceSource } from "@intx/types/runtime";
import type { GoalEvaluateArgs, GoalEvaluateFn, GoalEvaluateVerdict } from "./goal.js";

const VerdictSchema = type({
  met: "boolean",
  reason: "string",
});

const SYSTEM_INSTRUCTION = [
  "You are a strict goal-completion evaluator for a coding agent session.",
  "Decide whether the stated goal condition is verifiably met based ONLY on the",
  "evidence provided. Do not invent work that is not evidenced.",
  "",
  "Rules:",
  "- met=true only when the evidence clearly shows the condition is satisfied.",
  "- If evidence is missing, incomplete, or only claims progress without proof,",
  "  met=false.",
  "- Prefer false negatives over false positives.",
  "- reason must be one short sentence a human can act on.",
  "",
  "Respond with a single JSON object and nothing else:",
  '{ "met": true | false, "reason": "<brief explanation>" }',
].join("\n");

export type GoalEvaluatorCompleteFn = (
  turns: ConversationTurn[],
  source: InferenceSource,
  signal: AbortSignal,
) => Promise<{ text: string; evalTokens: number }>;

export type CreateGoalEvaluatorOpts = {
  /** Resolve the inference source for evaluation (prefer fast tier). */
  getSource: () => InferenceSource | undefined;
  deps?: Dependencies;
  complete?: GoalEvaluatorCompleteFn;
  signal?: () => AbortSignal;
};

function extractJSONObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Models sometimes wrap JSON in prose or fences; pull the first object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("evaluator response was not valid JSON");
  }
}

function defaultComplete(deps: Dependencies): GoalEvaluatorCompleteFn {
  return async (turns, source, signal) => {
    let seq = 0;
    let out = "";
    let evalTokens = 0;
    for await (const event of runInference({
      turns,
      source,
      signal,
      nextSeq: () => seq++,
      deps,
    })) {
      if (event.type === "inference.done") {
        for (const block of event.data.turn.content) {
          if (block.type === "text") out += block.text;
        }
        const usage = event.data.usage;
        if (usage !== undefined) {
          evalTokens = (usage.input ?? 0) + (usage.output ?? 0);
        }
      } else if (event.type === "inference.error") {
        throw new Error(event.data.error.message);
      }
    }
    return { text: out.trim(), evalTokens };
  };
}

function buildEvidencePrompt(condition: string, evidence: string): string {
  const body =
    evidence.trim().length > 0
      ? evidence.trim()
      : "(no evidence provided — treat as not met)";
  return [
    `Goal condition:\n${condition.trim()}`,
    "",
    "Evidence from the session:",
    body,
  ].join("\n");
}

/**
 * One-shot, no-tools evaluator. Fail-open callers treat thrown errors and
 * `{ error: true }` as not-met; this helper returns structured verdicts and
 * only throws when the model call itself fails (caller may catch).
 */
export function createGoalEvaluator(opts: CreateGoalEvaluatorOpts): GoalEvaluateFn {
  const complete = opts.complete ?? defaultComplete(opts.deps ?? ({} as Dependencies));

  return async (args: GoalEvaluateArgs): Promise<GoalEvaluateVerdict> => {
    const source = opts.getSource();
    if (source === undefined) {
      return {
        met: false,
        reason: "No evaluator model configured (set a fast tier or session model).",
        error: true,
      };
    }

    if (args.evidence.trim().length === 0) {
      return {
        met: false,
        reason: "No evidence available to verify the goal.",
      };
    }

    const turns: ConversationTurn[] = [
      {
        role: "system",
        content: [{ type: "text", text: SYSTEM_INSTRUCTION }],
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: [{ type: "text", text: buildEvidencePrompt(args.condition, args.evidence) }],
        timestamp: Date.now(),
      },
    ];

    const signal = opts.signal?.() ?? new AbortController().signal;
    let text: string;
    let evalTokens = 0;
    try {
      const result = await complete(turns, source, signal);
      text = result.text;
      evalTokens = result.evalTokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        met: false,
        reason: `Evaluator call failed: ${message}`,
        error: true,
        evalTokens,
      };
    }

    if (text.length === 0) {
      return {
        met: false,
        reason: "Evaluator returned empty response.",
        error: true,
        evalTokens,
      };
    }

    let raw: unknown;
    try {
      raw = extractJSONObject(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        met: false,
        reason: `Evaluator parse failed: ${message}`,
        error: true,
        evalTokens,
      };
    }

    const parsed = VerdictSchema(raw);
    if (parsed instanceof type.errors) {
      return {
        met: false,
        reason: `Evaluator schema invalid: ${parsed.summary}`,
        error: true,
        evalTokens,
      };
    }

    return {
      met: parsed.met,
      reason: parsed.reason.trim().length > 0 ? parsed.reason.trim() : parsed.met ? "met" : "not met",
      evalTokens,
    };
  };
}

/** Build a bounded evidence string from recent conversation turns. */
export function evidenceFromTurns(turns: ConversationTurn[], maxChars = 12_000): string {
  const chunks: string[] = [];
  let used = 0;
  // Prefer recent turns: walk from the end and reverse for chronological order.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn === undefined) continue;
    const parts: string[] = [];
    for (const block of turn.content) {
      if (block.type === "text" && block.text.trim().length > 0) {
        parts.push(block.text.trim().slice(0, 800));
      } else if (block.type === "tool_call") {
        const args = block.arguments as Record<string, unknown> | undefined;
        const path = typeof args?.path === "string" ? args.path : undefined;
        parts.push(`tool ${block.name}${path !== undefined ? ` ${path}` : ""}`);
      } else if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
                  .join("")
              : "";
        if (text.trim().length > 0) {
          parts.push(`result: ${text.trim().slice(0, 400)}`);
        }
      }
    }
    if (parts.length === 0) continue;
    const line = `${turn.role}: ${parts.join(" | ")}`;
    if (used + line.length > maxChars) break;
    chunks.push(line);
    used += line.length;
  }
  return chunks.reverse().join("\n");
}
