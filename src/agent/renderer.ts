import type { ReactorEmittedEvent } from "@intx/inference";
import type { LastCycleSource, TokenUsage } from "@intx/types/runtime";

import { formatSessionCostCopy } from "../cost/cost-summary.js";
import { formatCost } from "../cost/faremeter.js";
import type { PricingCache } from "../cost/pricing-fetcher.js";
import {
  billingIdentityFromSource,
  createSessionCostAccumulator,
  type TurnBillingIdentity,
} from "../cost/session-cost.js";
import { inferenceErrorMessage } from "../inference-error-message.js";

export interface Renderer {
  render(event: ReactorEmittedEvent): void;
}

const DIM = "\x1b[2m";
const AMBER = "\x1b[38;5;214m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const SILENT_TOOLS = new Set(["read_file", "list_dir", "search_files", "grep"]);

function verb(label: string): string {
  return `${DIM}${label.padStart(6)}${RESET}  `;
}

function miniDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const lines: string[] = [];

  // Simple: show removed lines then added lines with 1-line context from old
  for (const line of oldLines) {
    lines.push(`        ${RED}-${RESET} ${line}`);
  }
  for (const line of newLines) {
    lines.push(`        ${GREEN}+${RESET} ${line}`);
  }

  if (lines.length > 10) {
    const kept = lines.slice(0, 10);
    kept.push(`        ${DIM}... ${lines.length - 10} more${RESET}`);
    return kept.join("\n");
  }
  return lines.join("\n");
}

function formatOp(name: string): string {
  if (SILENT_TOOLS.has(name)) {
    return name === "read_file"
      ? "reading"
      : name === "list_dir"
        ? "listing"
        : name === "search_files"
          ? "searching"
          : "grepping";
  }
  if (name === "run_shell") return "running";
  if (name === "write_file") return "writing";
  if (name === "edit_file") return "editing";
  if (name === "submit_output") return "submitting";
  return name;
}

function tokenUsageFromEvent(data: Record<string, unknown> | undefined): TokenUsage | null {
  const usage = data?.usage;
  if (usage === null || typeof usage !== "object") return null;
  const fields = usage as Record<string, unknown>;
  if (typeof fields.input !== "number" || typeof fields.output !== "number") return null;
  return {
    input: fields.input,
    output: fields.output,
    cacheRead: typeof fields.cacheRead === "number" ? fields.cacheRead : 0,
    cacheWrite: typeof fields.cacheWrite === "number" ? fields.cacheWrite : 0,
    thinking: typeof fields.thinking === "number" ? fields.thinking : 0,
  };
}

function billingIdentityFromEvent(
  data: Record<string, unknown> | undefined,
  fallbackModelId: string,
): TurnBillingIdentity {
  const source = data?.source;
  if (source === null || typeof source !== "object") {
    return { modelId: fallbackModelId };
  }
  const fields = source as Record<string, unknown>;
  if (typeof fields.sourceId !== "string" || typeof fields.model !== "string") {
    return { modelId: fallbackModelId };
  }
  return billingIdentityFromSource(fields as LastCycleSource);
}

export function createRenderer(
  startedAt: number,
  modelId?: string,
  pricingCache?: PricingCache | null,
): Renderer {
  let currentOp = "";
  let currentArg = "";
  let turnCount = 0;
  const pendingArgs = new Map<string, Record<string, unknown>>();
  const pendingNames = new Map<string, string>();
  let pendingSubmitSummary: string | undefined;
  const sessionCost = createSessionCostAccumulator({
    pricingCache: () => pricingCache ?? null,
  });

  function elapsedSecs(): number {
    return Math.floor((Date.now() - startedAt) / 1000);
  }

  function costText(): string {
    const billed = sessionCost.snapshot();
    return formatSessionCostCopy({
      mix: billed.mix,
      formattedCost: formatCost(billed.meteredCost),
      sessionHiddenReason: billed.hiddenReason,
    });
  }

  function writeStatusBar(): void {
    const opText =
      currentOp.length > 0
        ? `${AMBER}${currentOp}${currentArg ? " " + currentArg : ""}${RESET}`
        : "";
    const bar = `${DIM}interchange  ·  turn ${turnCount}  ·  ${costText()}  ·  ${RESET}${opText}${DIM}  ·  ${elapsedSecs()}s${RESET}\r`;
    process.stderr.write(bar);
  }

  function writeWriteBlock(path: string, content: string): void {
    const lineCount = content.split("\n").length;
    const delta = `${GREEN}+${lineCount}${RESET}`;
    process.stdout.write(
      `${verb("write")}${path}${DIM}${" ".repeat(Math.max(1, 44 - path.length))}${RESET}${delta}\n\n`,
    );
  }

  function writeEditBlock(path: string, oldStr: string, newStr: string): void {
    const removed = oldStr ? oldStr.split("\n").length : 0;
    const added = newStr ? newStr.split("\n").length : 0;
    const delta = `${GREEN}+${added}${RESET} ${RED}-${removed}${RESET}`;
    const diff = miniDiff(oldStr ?? "", newStr ?? "");
    process.stdout.write(
      `${verb("edit")}${path}${DIM}${" ".repeat(Math.max(1, 44 - path.length))}${RESET}${delta}\n${diff}\n\n`,
    );
  }

  function writeShellBlock(command: string, output: string, isError: boolean): void {
    const status = isError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
    if (isError) {
      process.stdout.write(
        `${verb("shell")}${command}${DIM}${" ".repeat(Math.max(1, 44 - command.length))}${RESET}${status}\n        ${output}\n\n`,
      );
    } else {
      process.stdout.write(
        `${verb("shell")}${command}${DIM}${" ".repeat(Math.max(1, 44 - command.length))}${RESET}${status}\n\n`,
      );
    }
  }

  function writeDoneBlock(summary: string): void {
    process.stdout.write(`${verb("done")}${GREEN}${summary}${RESET}\n\n`);
  }

  function writeErrorBlock(message: string): void {
    process.stdout.write(`${verb("error")}${RED}${message}${RESET}\n\n`);
  }

  function render(event: ReactorEmittedEvent): void {
    const e = event as { type: string; seq?: number; data?: Record<string, unknown> };

    switch (e.type) {
      case "inference.tool_call.start": {
        const name = String(e.data?.name ?? "");
        currentOp = formatOp(name);
        currentArg =
          name === "read_file" || name === "list_dir" || name === "search_files" || name === "grep"
            ? String((e.data as Record<string, unknown>).callId ?? "")
            : "";
        break;
      }

      case "inference.tool_call.end": {
        const callId = String(e.data?.callId ?? "");
        const name = String(e.data?.name ?? "");
        const args = (e.data?.arguments ?? {}) as Record<string, unknown>;
        pendingArgs.set(callId, args);
        pendingNames.set(callId, name);

        if (name === "submit_output") {
          pendingSubmitSummary = String(args.summary ?? "");
        }
        break;
      }

      case "inference.done": {
        turnCount++;
        currentOp = "";
        currentArg = "";
        const usage = tokenUsageFromEvent(e.data);
        if (usage !== null) {
          sessionCost.addTurn(usage, billingIdentityFromEvent(e.data, modelId ?? ""));
        }
        break;
      }

      case "tool.start": {
        const callName = String((e.data?.call as Record<string, unknown>)?.name ?? "");
        currentOp = formatOp(callName);
        currentArg = "";
        break;
      }

      case "tool.done": {
        const result = e.data?.result as Record<string, unknown>;
        const callId = String(result?.callId ?? "");
        const isError = Boolean(result?.isError);
        const content = String(result?.content ?? "");
        const name = pendingNames.get(callId);
        const args = pendingArgs.get(callId) ?? {};

        currentOp = "";
        currentArg = "";

        if (name === undefined || SILENT_TOOLS.has(name)) {
          break;
        }

        if (name === "write_file" && !isError) {
          writeWriteBlock(String(args.path ?? ""), String(args.content ?? ""));
        } else if (name === "edit_file" && !isError) {
          writeEditBlock(
            String(args.path ?? ""),
            String(args.old_string ?? ""),
            String(args.new_string ?? ""),
          );
        } else if (name === "run_shell") {
          writeShellBlock(String(args.command ?? ""), content, isError);
        } else if (name === "submit_output" && !isError) {
          writeDoneBlock(String(args.summary ?? pendingSubmitSummary ?? ""));
        }

        pendingArgs.delete(callId);
        pendingNames.delete(callId);
        break;
      }

      case "reactor.done": {
        currentOp = "done";
        writeDoneBlock("reactor finished");
        break;
      }

      case "inference.error": {
        const err = e.data?.error as Record<string, unknown> | undefined;
        const rawMessage = String(err?.message ?? e.data?.error ?? "inference error");
        const message =
          typeof err?.category === "string"
            ? inferenceErrorMessage({
                category: err.category,
                message: rawMessage,
                ...(typeof err.statusCode === "number" ? { statusCode: err.statusCode } : {}),
                ...(err.raw !== undefined ? { raw: err.raw } : {}),
                ...(typeof err.providerId === "string" ? { providerId: err.providerId } : {}),
              })
            : rawMessage;
        writeErrorBlock(message);
        break;
      }

      case "reactor.error": {
        writeErrorBlock(String(e.data?.error ?? "reactor error"));
        break;
      }

      case "connector.reply": {
        currentOp = "";
        break;
      }
    }

    writeStatusBar();
  }

  return { render };
}
