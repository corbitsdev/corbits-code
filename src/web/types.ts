import { type } from "arktype";

// Closed-core result shape. The prompt depends only on these three fields.
// The extra bag is namespaced and validated at the provider boundary.
export const WebResultValidator = type({
  title: "string",
  url: "string",
  snippet: "string",
  "extra?": "Record<string, unknown>",
});

export type WebResult = typeof WebResultValidator.infer;

// Provider interface. A single provider implements both search and fetch
// so exactly one backend ever registers (avoids the duplicate-tool-name crash
// in createPosixTools).
export interface WebProvider {
  readonly name: string;
  search(query: string, signal: AbortSignal): Promise<WebResult[]>;
  fetch(url: string, signal: AbortSignal): Promise<string>;
}

// Three-outcome taxonomy for web tool results:
//   results      -> non-empty WebResult[]
//   empty-but-ok -> empty WebResult[] (isError: false)
//   error        -> isError: true, content prefixed with "Error:"
//
// The director's isSuccessfulToolResult treats any content starting with
// "Error:" as failure regardless of the isError flag, so we never emit a
// string starting with "Error:" on success paths.
