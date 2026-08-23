import { requestModelsEndpoint } from "../provider/models-endpoint.js";

/**
 * Fetch the model list from a Bifrost gateway for the given virtual key.
 * Uses both the x-bf-vk header (as recommended for scoping) and a
 * conventional Bearer Authorization so either auth style works.
 *
 * Returns only the model id strings. Throws on HTTP or parse errors.
 */
export async function fetchBifrostModels(baseURL: string, apiKey: string): Promise<string[]> {
  const headers: Record<string, string> = {
    "x-bf-vk": apiKey,
  };
  if (apiKey && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const res = await requestModelsEndpoint({ baseURL, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to list Bifrost models (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { data?: { id?: unknown }[] };
  return (json.data ?? [])
    .map((d) => (typeof d.id === "string" ? d.id : undefined))
    .filter((id): id is string => id !== undefined && id.length > 0);
}
