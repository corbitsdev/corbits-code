// Onboarding submits provider credentials before they've ever been used for
// inference — a bad base URL or key otherwise only surfaces as a stream error
// mid-conversation. This does a lightweight GET against the OpenAI-compatible
// /models endpoint (supported by every provider intercode targets, including
// keyless local ones like Ollama) to fail fast with an actionable message.

import { requestModelsEndpoint } from "./models-endpoint.js";

export type ConnectionCheck = {
  baseURL: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
};

export type ConnectionCheckResult = { ok: true } | { ok: false; error: string };

const connectionFailure = (error: string): ConnectionCheckResult => ({ ok: false, error });

export async function validateProviderConnection({
  baseURL,
  apiKey,
  timeoutMs,
}: ConnectionCheck): Promise<ConnectionCheckResult> {
  const headers: Record<string, string> = {};
  if (apiKey !== undefined && apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await requestModelsEndpoint({
      baseURL,
      headers,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return connectionFailure(`Connection test timed out reaching ${baseURL}`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    return connectionFailure(`Could not reach ${baseURL}: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim().length > 0 ? ` — ${body.trim().slice(0, 200)}` : "";
    return connectionFailure(`Connection test failed (${response.status} ${response.statusText})${detail}`);
  }

  return { ok: true };
}
