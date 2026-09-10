/**
 * Input masking and summary rendering for the provider setup form: how a typed
 * secret is echoed and folded back, and how the per-step summary column reads.
 */

import { UI } from "../theme.js";
import { type ProviderField, stepLabel, type SetupStep } from "./steps.js";
import type {
  ProviderChoice,
  ProviderFormValues,
  SubmitPhase,
} from "./types.js";

/** Placeholder shown in the text input for each free-text step. */
export const PROVIDER_FIELD_HINTS: Record<ProviderField, string> = {
  name: "openai, anthropic, ollama, …",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-… (blank for keyless/local)",
  model: "gpt-4o",
};

/** Placeholder for the OAuth account-name step, which edits `oauthProfile`. */
export const OAUTH_PROFILE_HINT = "default, personal, work, …";

const MASK_CHAR = "●";
const MASK_CAP = 16;

/**
 * Bullet-render a secret for the read-only summary rows, capped so a long key
 * does not blow out the row width.
 */
export function maskSecret(value: string): string {
  return MASK_CHAR.repeat(Math.min([...value].length, MASK_CAP));
}

/**
 * Bullet-render a secret for the live input echo.
 *
 * Uncapped, unlike `maskSecret`: the echo is what `secretFromMaskedEdit` reads
 * back, so a capped echo would silently discard everything past the cap.
 */
export function maskEcho(value: string): string {
  return MASK_CHAR.repeat([...value].length);
}

/** apiKey is optional — blank means a keyless local provider (e.g. Ollama). */
export function stepReady(step: SetupStep, value: string): boolean {
  return step === "apiKey" || value.trim().length > 0;
}

/**
 * Fold an edit of the masked apiKey display back into the real secret.
 *
 * The input never holds the key: every keystroke is mirrored back as bullets,
 * so an edit arrives as bullets plus whatever was just typed. Appends and
 * end-of-line deletes round-trip exactly; mid-string edits fall back to
 * truncation, which is why the field is re-typed rather than patched.
 */
export function secretFromMaskedEdit(
  secret: string,
  displayed: string,
): string {
  const chars = [...displayed];
  const typed = chars.filter((c) => c !== MASK_CHAR);
  const keptLength = chars.length - typed.length;
  return [...secret].slice(0, keptLength).join("") + typed.join("");
}

/** `step 2 of 4 · api key` — always says where the operator is and what is left. */
export function stepHeadline(
  steps: readonly SetupStep[],
  index: number,
  choice: ProviderChoice | null = null,
): string {
  const step = steps[Math.min(Math.max(index, 0), steps.length - 1)];
  if (step === undefined) return "";
  return `step ${index + 1} of ${steps.length} · ${stepLabel(step, choice)}`;
}

export interface SummaryRow {
  readonly label: string;
  readonly value: string;
  readonly state: "done" | "current" | "pending";
}

/** One row per step: settled rows show the value, later rows a dash. */
export function summaryRows(
  steps: readonly SetupStep[],
  index: number,
  values: ProviderFormValues,
  choice: ProviderChoice | null,
): readonly SummaryRow[] {
  return steps.map((step, i) => {
    const state = i < index ? "done" : i === index ? "current" : "pending";
    return {
      label: stepLabel(step, choice),
      value: state === "done" ? settledValue(step, values, choice) : "—",
      state,
    };
  });
}

function settledValue(
  step: SetupStep,
  values: ProviderFormValues,
  choice: ProviderChoice | null,
): string {
  if (step === "provider") return choice?.label ?? values.name;
  if (step === "login")
    return values.name.length > 0 ? values.name : "signed in";
  if (step === "apiKey") {
    return values.apiKey.length > 0 ? maskSecret(values.apiKey) : "keyless";
  }
  if (step === "name") {
    return choice !== null && !choice.custom
      ? values.oauthProfile
      : values.name;
  }
  if (step === "baseURL") return values.baseURL;
  return values.model;
}

/** Render a summary row at a fixed label column. */
export function summaryLine(row: SummaryRow): string {
  const marker = row.state === "current" ? "›" : " ";
  return `${marker} ${row.label.padEnd(14)}${row.state === "current" ? "" : row.value}`;
}

export function summaryColor(row: SummaryRow): string {
  if (row.state === "done") return UI.done;
  if (row.state === "current") return UI.text;
  return UI.textFaint;
}

/**
 * What the operator should do about a failure. A bare error message leaves a
 * first-run user stuck, so every failure names the field to fix.
 */
export function failureGuidance(
  phase: SubmitPhase,
  choice: ProviderChoice | null,
  offerSaveAnyway = true,
): string {
  if (phase === "saving") {
    return "settings could not be written — check disk permissions, enter to retry";
  }
  if (!offerSaveAnyway) {
    return choice !== null && !choice.custom
      ? "the account cannot be saved — esc to reconnect or enter to retry"
      : "check the base url and key — esc to go back, enter to retry";
  }
  return choice !== null && !choice.custom
    ? "the key was rejected or unreachable — esc to re-enter it, enter to retry, ctrl+s to save anyway"
    : "check the base url and key — esc to go back, enter to retry, ctrl+s to save anyway";
}
