import { xaiUserIdFromAccessToken } from "@corbits/xai-provider";
import type { CredentialMaterial } from "@intx/types";

import {
  findSourceCredentialRecord,
  rotateSourceCredentialMaterialIfCurrent,
  type SourceCredentialProvenance,
  type SourceCredentialRecord,
} from "../config/source-credentials.js";
import { getValidCodexToken } from "./codex/session.js";
import { getValidXaiToken } from "./xai/session.js";

export type OAuthCredentialProvenance = Extract<
  SourceCredentialProvenance,
  { kind: "oauth" }
>;

async function resolveOAuthCredentialMaterial(
  provenance: OAuthCredentialProvenance,
): Promise<CredentialMaterial> {
  if (provenance.provider === "codex") {
    const fresh = await getValidCodexToken(provenance.profile);
    return {
      secret: fresh.access,
      ...(fresh.accountId !== undefined
        ? { headers: { "chatgpt-account-id": fresh.accountId } }
        : {}),
    };
  }

  const fresh = await getValidXaiToken(provenance.profile);
  const userId = xaiUserIdFromAccessToken(fresh.access);
  return {
    secret: fresh.access,
    ...(userId !== undefined ? { headers: { "x-grok-user-id": userId } } : {}),
  };
}

export async function refreshSourceCredentialByProvenance(
  credentialId: string,
): Promise<boolean> {
  const record = findSourceCredentialRecord(credentialId);
  if (record === undefined) return false;
  return refreshSourceCredentialFromRecord(credentialId, record);
}

/** Refreshes from a caller-held record snapshot taken before the caller's first
 * await, so a deferred refresh compares against its original registration and
 * cannot overwrite a newer one. */
export async function refreshSourceCredentialFromRecord(
  credentialId: string,
  record: SourceCredentialRecord,
): Promise<boolean> {
  if (record.provenance.kind !== "oauth") return false;
  const material = await resolveOAuthCredentialMaterial(record.provenance);
  return rotateSourceCredentialMaterialIfCurrent(
    credentialId,
    record,
    material,
  );
}
