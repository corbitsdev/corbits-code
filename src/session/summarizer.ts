// Model-backed compaction summarizer.
//
// When the context crosses the compaction threshold, the pruning compactor
// replaces older turns with a summary. A deterministic stats blob ("Turns: N,
// Tools called: ...") loses everything that matters for resuming work, so this
// module produces a structured, workflow-aware narrative via a one-shot
// inference call against the session's own model. Failure is fatal to that
// compact cycle: the caller retains the prior context instead of substituting
// a statistics-only stub.

import { type } from "arktype";
import { runInference, type Dependencies } from "@intx/inference";
import { createDefaultDependencies } from "@intx/inference/providers";
import { getLogger } from "@intx/log";
import {
  InferenceError,
  type ConversationTurn,
  type InferenceSource,
  type RetryPolicy,
} from "@intx/types/runtime";
import { LOG_NAMESPACE_ROOT } from "../branding.js";
import { NOOP_TELEMETRY, type Telemetry } from "../telemetry/index.js";
import {
  buildArchiveSummaryExcerpt,
  type SummaryExcerptArchive,
} from "./summary-excerpt.js";

const logger = getLogger([LOG_NAMESPACE_ROOT, "session", "summarizer"]);

// What the agent was doing when compaction fired. Lets the summary preserve
// the workflow contract ("we are at step 3/7 of /build") rather than dropping
// it into the compacted region.
export interface SummaryContext {
  workflow?: {
    name?: string;
    stepLabel?: string;
    stepIndex?: number;
    total?: number;
  };
}

const SYSTEM_INSTRUCTION = [
  "You are compacting the context of an in-progress coding session so the agent",
  "can keep working with a much shorter history. Read the session excerpt and",
  "produce a tight, factual handoff. Do not invent anything not present in the",
  "excerpt. Use exactly these sections, each as a short markdown block:",
  "",
  "## What Happened",
  "Bullet the concrete work already done (files changed, decisions made, things",
  "discovered, things that failed and why).",
  "",
  "## What We're Doing",
  "One or two sentences on the current objective and, if a workflow is active,",
  "which workflow and step we are on.",
  "",
  "## Relevant Links",
  "URLs, file paths, identifiers (tickets, commits, symbols) that later turns",
  "will need. Omit the section if there are none.",
  "",
  "## Action Items",
  "Concrete things still owed, with enough detail to act on without re-reading",
  "the dropped history.",
  "",
  "## Next Steps",
  "The immediate next action(s) to take right now.",
  "",
  "Be specific and terse. Prefer paths, names, and exact values over prose.",
  "When the excerpt includes archive:/// refs, keep those identifiers so later",
  "turns can retrieve the evidence. Do not invent archive contents.",
].join("\n");

// Pull a compact, model-readable excerpt out of the turns being dropped:
// recent user asks, assistant reasoning snippets, tool calls and the files
// they touched. Bounded so the summary call itself stays cheap.
export function condenseTurns(turns: ConversationTurn[]): string {
  const userMessages: string[] = [];
  const assistantSnippets: string[] = [];
  const toolNames = new Set<string>();
  const files = new Set<string>();
  const links = new Set<string>();

  for (const turn of turns) {
    for (const block of turn.content) {
      if (block.type === "text") {
        const urls = block.text.match(/https?:\/\/[^\s)]+/g);
        if (urls) for (const u of urls) links.add(u);
        if (turn.role === "user") {
          userMessages.push(block.text.slice(0, 400));
        } else if (turn.role === "assistant" && block.text.length > 0) {
          assistantSnippets.push(block.text.slice(0, 300));
        }
      }
      if (block.type === "tool_call") {
        toolNames.add(block.name);
        const args = block.arguments as Record<string, unknown> | undefined;
        const path = args?.path ?? args?.file;
        if (typeof path === "string" && path.length > 0) files.add(path);
        const url = args?.url;
        if (typeof url === "string" && url.length > 0) links.add(url);
      }
    }
  }

  const sections: (string | null)[] = [
    `Turns dropped: ${turns.length}`,
    toolNames.size > 0
      ? `Tools used: ${[...toolNames].sort().join(", ")}`
      : null,
    files.size > 0
      ? `Files touched:\n${[...files]
          .slice(0, 40)
          .map((f) => `- ${f}`)
          .join("\n")}`
      : null,
    links.size > 0
      ? `Links/identifiers:\n${[...links]
          .slice(0, 30)
          .map((l) => `- ${l}`)
          .join("\n")}`
      : null,
    userMessages.length > 0
      ? `User messages (most recent last):\n${userMessages.slice(-6).join("\n---\n")}`
      : null,
    assistantSnippets.length > 0
      ? `Assistant notes (excerpts):\n${assistantSnippets.slice(-8).join("\n---\n")}`
      : null,
  ];

  return sections.filter((s): s is string => s !== null).join("\n\n");
}

function workflowPreamble(ctx: SummaryContext | undefined): string {
  const parts: string[] = [];
  const wf = ctx?.workflow;
  if (wf !== undefined && wf.name !== undefined) {
    const step =
      wf.stepIndex !== undefined && wf.total !== undefined
        ? ` (step ${wf.stepIndex + 1}/${wf.total}${wf.stepLabel ? `: ${wf.stepLabel}` : ""})`
        : wf.stepLabel
          ? ` (current step: ${wf.stepLabel})`
          : "";
    parts.push(
      `Active workflow: /${wf.name}${step}\nThis session is mid-workflow — preserve everything needed to resume it.`,
    );
  }
  if (parts.length === 0) return "";
  return `${parts.join("\n\n")}\n\n`;
}

/** Build the user-content prompt for the summary call. Pure and testable. */
export function buildSummaryPrompt(
  turns: ConversationTurn[],
  ctx?: SummaryContext,
  excerpt?: string,
): string {
  const body =
    excerpt !== undefined && excerpt.length > 0
      ? excerpt
      : condenseTurns(turns);
  return `${workflowPreamble(ctx)}Session excerpt:\n\n${body}`;
}

// Per-call wall-clock cap for the summary call. Compaction runs inline on the
// reactor, so a summarizer that inherits the director's 600 s budget freezes
// the session for the full window; the summary prompt is small and a slow
// answer is almost always a stuck call, not a thinking model.
export const DEFAULT_SUMMARIZER_TIMEOUT_MS = 90_000;

// The harness's default policy retries retryable and timeout categories up to
// three times inside one call. The summarizer owns its retry budget instead —
// one retry per failure class below — so a stalled call cannot multiply into
// minutes of frozen reactor.
const NO_HARNESS_RETRY: RetryPolicy = () => ({ kind: "abort" });

// Low-level completion: one inference round-trip returning assistant text.
// Injectable so tests can drive the summarizer without a live model.
export type CompletionFn = (
  turns: ConversationTurn[],
  source: InferenceSource,
  signal: AbortSignal,
) => Promise<string>;

function defaultComplete(deps: Dependencies, timeoutMs: number): CompletionFn {
  return async (turns, source, signal) => {
    let seq = 0;
    let out = "";
    for await (const event of runInference({
      turns,
      source,
      signal,
      nextSeq: () => seq++,
      deps,
      inferenceOptions: {
        totalTimeoutMs: timeoutMs,
        retryPolicy: NO_HARNESS_RETRY,
      },
    })) {
      if (event.type === "inference.done") {
        for (const block of event.data.turn.content) {
          if (block.type === "text") out += block.text;
        }
      } else if (event.type === "inference.error") {
        throw new Error(event.data.error.message, {
          cause: event.data.error,
        });
      }
    }
    return out.trim();
  };
}

// The class a failed summary call falls into. `auth` and `provider` each earn
// one retry; `timeout` never does — the point of the smaller cap is to stop a
// stalled call from freezing the reactor, and retrying would double the stall.
export type SummarizerFailureClass =
  | "auth"
  | "provider"
  | "timeout"
  | "aborted"
  | "empty"
  | "failed";

const EMPTY_SUMMARY_MESSAGE = "compaction summary returned empty text";

// xAI's Responses proxy reports mid-stream generation failures as a
// response.failed envelope, which the adapter classifies protocol_mismatch —
// a category the harness never retries, though the fault is transient.
const PROVIDER_INTERNAL_ERROR = /internal error during token generation/i;

// defaultComplete attaches the harness's classified InferenceError as `cause`;
// errors without one (injected fakes, thrown parser detail) classify by
// bounded message markers.
function inferenceErrorCause(error: unknown): InferenceError | undefined {
  if (!(error instanceof Error) || error.cause === undefined) return undefined;
  const parsed = InferenceError(error.cause);
  return parsed instanceof type.errors ? undefined : parsed;
}

function classifySummarizerFailure(error: unknown): SummarizerFailureClass {
  const cause = inferenceErrorCause(error);
  if (cause !== undefined) {
    if (cause.category === "aborted") return "aborted";
    if (cause.category === "timeout") return "timeout";
    if (
      cause.category === "credential_failure" ||
      cause.statusCode === 401 ||
      cause.statusCode === 403
    )
      return "auth";
    if (
      (cause.statusCode !== undefined &&
        cause.statusCode >= 500 &&
        cause.statusCode < 600) ||
      PROVIDER_INTERNAL_ERROR.test(cause.message)
    )
      return "provider";
    return "failed";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === EMPTY_SUMMARY_MESSAGE) return "empty";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (/\b(?:timeout|timed out)\b/i.test(message)) return "timeout";
  if (/\b(?:401|403)\b|\bunauthorized\b/i.test(message)) return "auth";
  if (/\b5\d\d\b/.test(message) || PROVIDER_INTERNAL_ERROR.test(message))
    return "provider";
  return "failed";
}

// One-line operator notice for a final failure. The reason named is the
// provider's own first line when short enough to be useful, else the class.
function failureNotice(
  failureClass: SummarizerFailureClass,
  error: Error,
): string {
  const firstLine = error.message.split("\n", 1)[0]?.trim() ?? "";
  const reason =
    firstLine.length > 0
      ? firstLine.length > 140
        ? `${firstLine.slice(0, 140)}...`
        : firstLine
      : failureClass;
  return `Compaction summary failed — keeping prior context (${reason})`;
}

export interface ModelSummarizerOptions {
  /** Returns the source to summarize with — read live so model switches apply. */
  getSource: () => InferenceSource;
  /** Abort signal source; the summary call is cancelled if the session ends. */
  getSignal?: () => AbortSignal;
  /** Override the completion path (tests inject a fake here). */
  complete?: CompletionFn;
  deps?: Dependencies;
  /** Cap on the returned summary length. */
  maxChars?: number;
  /**
   * Per-call wall-clock cap for the summary call, profile-configurable via
   * `summarizerTimeoutMs`. Deliberately far below the director's
   * `totalTimeoutMs` — compaction blocks the reactor, so a stuck summary call
   * must give up in seconds, not minutes.
   */
  timeoutMs?: number | undefined;
  /**
   * Re-read the provider credential (OAuth token store) before the single
   * `auth` retry. Several processes share one auth file, so a 401 may only
   * mean this process holds a token another already rotated.
   */
  refreshAuth?: (() => Promise<void>) | undefined;
  /** Fires once per failed `summarize` call, after the retry budget is spent. */
  onFailure?: ((text: string) => void) | undefined;
  telemetry?: Telemetry | undefined;
  /** Primary sessions pass the evidence archive so the prompt is not a clipped stub. */
  getArchive?: () => SummaryExcerptArchive | undefined;
}

/**
 * Build a `summarize(turns, ctx)` function suitable for `CompactorConfig`.
 * Produces a structured, workflow-aware summary via the model. Empty output
 * or a failed call throws so the compact cycle can keep the prior context
 * instead of replacing it with a statistics-only stub.
 */
export function createModelSummarizer(
  options: ModelSummarizerOptions,
): (turns: ConversationTurn[], ctx?: SummaryContext) => Promise<string> {
  const deps = options.deps ?? createDefaultDependencies();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUMMARIZER_TIMEOUT_MS;
  const complete = options.complete ?? defaultComplete(deps, timeoutMs);
  const maxChars = options.maxChars ?? 4000;
  const telemetry = options.telemetry ?? NOOP_TELEMETRY;

  return async (turns, ctx) => {
    const startedAt = Date.now();
    const archive = options.getArchive?.();
    const excerpt =
      archive !== undefined
        ? await buildArchiveSummaryExcerpt(archive)
        : undefined;
    const promptTurns: ConversationTurn[] = [
      {
        role: "system",
        content: [{ type: "text", text: SYSTEM_INSTRUCTION }],
        timestamp: turns[0]?.timestamp ?? 0,
      },
      {
        role: "user",
        content: [
          { type: "text", text: buildSummaryPrompt(turns, ctx, excerpt) },
        ],
        timestamp: 0,
      },
    ];

    // One retry per failure class. Auth retries refresh the credential first
    // when a hook is wired; provider retries replay the call as-is.
    const retried = new Set<SummarizerFailureClass>();
    for (;;) {
      try {
        const signal = options.getSignal?.() ?? new AbortController().signal;
        const text = await complete(promptTurns, options.getSource(), signal);
        if (text.length === 0) {
          logger.warn("compaction summary call returned empty text");
          throw new Error(EMPTY_SUMMARY_MESSAGE);
        }
        return text.length > maxChars ? text.slice(0, maxChars) : text;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const failureClass = classifySummarizerFailure(err);
        const retryable =
          (failureClass === "auth" && options.refreshAuth !== undefined) ||
          failureClass === "provider";
        if (retryable && !retried.has(failureClass)) {
          retried.add(failureClass);
          logger.warn(
            "compaction summary call failed ({class}); retrying once: {error}",
            { class: failureClass, error: err.message },
          );
          if (failureClass === "auth") {
            try {
              await options.refreshAuth?.();
            } catch (refreshError) {
              logger.warn(
                "credential re-read after summary auth failure failed: {error}",
                {
                  error:
                    refreshError instanceof Error
                      ? refreshError.message
                      : String(refreshError),
                },
              );
            }
          }
          continue;
        }
        logger.warn("compaction summary call failed: {error}", {
          error: err.message,
        });
        const source = options.getSource();
        telemetry.capture("summarizer_failure", {
          provider: source.provider,
          model: source.model,
          error_kind: failureClass,
          duration_ms: Date.now() - startedAt,
        });
        options.onFailure?.(failureNotice(failureClass, err));
        throw err;
      }
    }
  };
}
