import { xaiUserIdFromAccessToken } from "@corbits/xai-provider";
import type { InferenceSource } from "@intx/types/runtime";

import { getValidCodexToken } from "../auth/codex/session.js";
import { getValidXaiToken } from "../auth/xai/session.js";
import type { ProviderCatalogEntry } from "../config/index.js";
import {
  findSourceCredentialRecord,
  rotateSourceCredentialMaterial,
} from "../config/source-credentials.js";

export async function ensureFreshInferenceSource(
  source: InferenceSource,
  _catalog: readonly ProviderCatalogEntry[] | undefined,
): Promise<InferenceSource> {
  const record = findSourceCredentialRecord(source.credentialId);
  if (record?.provenance.kind !== "oauth") return source;

  if (record.provenance.provider === "codex") {
    const fresh = await getValidCodexToken(record.provenance.profile);
    rotateSourceCredentialMaterial(source.credentialId, {
      secret: fresh.access,
      ...(fresh.accountId !== undefined
        ? { headers: { "chatgpt-account-id": fresh.accountId } }
        : {}),
    });
    return source;
  }

  const fresh = await getValidXaiToken(record.provenance.profile);
  const userId = xaiUserIdFromAccessToken(fresh.access);
  rotateSourceCredentialMaterial(source.credentialId, {
    secret: fresh.access,
    ...(userId !== undefined ? { headers: { "x-grok-user-id": userId } } : {}),
  });
  return source;
}

export async function refreshInferenceSourceBundle(
  sources: readonly InferenceSource[],
  defaultSource: string,
  catalog: readonly ProviderCatalogEntry[] | undefined,
): Promise<{ sources: InferenceSource[]; defaultSource: string }> {
  const refreshed = await Promise.all(
    sources.map((source) => ensureFreshInferenceSource(source, catalog)),
  );
  return { sources: refreshed, defaultSource };
}
