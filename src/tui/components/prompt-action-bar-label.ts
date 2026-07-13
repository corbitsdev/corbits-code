export type PromptActionBarModelLabelInput = {
  profile?: string;
  model?: string;
  effort?: string;
};

/** Right-aligned muted label above the prompt: `profile · model · effort` with omitted empty segments. */
export function composePromptActionBarModelLabel(
  input: PromptActionBarModelLabelInput,
): string | undefined {
  const segments: string[] = [];
  if (input.profile !== undefined && input.profile.length > 0) {
    segments.push(input.profile);
  }
  if (input.model !== undefined) {
    segments.push(input.model);
  }
  if (input.effort !== undefined && input.effort.length > 0) {
    segments.push(input.effort);
  }
  return segments.length > 0 ? segments.join(" · ") : undefined;
}