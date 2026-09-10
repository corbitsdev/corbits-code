import type { InferenceOptions } from "@intx/types/runtime";

export const OPENCODE_SESSION_ID_OPTION = "opencodeSessionId";

export function optionString(
  options: InferenceOptions,
  key: string,
): string | undefined {
  const value = options.providerOptions?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
