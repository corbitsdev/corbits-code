export const ESSENTIALS_SEPARATOR = " · ";

export interface PromptActionBarModelLabelInput {
  profile?: string;
  model?: string;
  effort?: string;
  mode?: string | undefined;
}

/** Right-aligned muted label above the prompt: `profile · model · effort · mode`, empty segments omitted. */
export function composePromptActionBarModelLabel(
  input: PromptActionBarModelLabelInput,
): string | undefined {
  const segments: string[] = [];
  if (input.profile !== undefined && input.profile.length > 0) {
    segments.push(input.profile);
  }
  if (input.model !== undefined && input.model.length > 0) {
    segments.push(input.model);
  }
  if (input.effort !== undefined && input.effort.length > 0) {
    segments.push(input.effort);
  }
  if (input.mode !== undefined && input.mode.length > 0) {
    segments.push(input.mode);
  }
  return segments.length > 0 ? segments.join(ESSENTIALS_SEPARATOR) : undefined;
}

/** Trailing label segment while permission prompts are skipped; undefined otherwise. */
export function yoloModeLabel(skipsPermissions: boolean): "yolo" | undefined {
  return skipsPermissions ? "yolo" : undefined;
}
