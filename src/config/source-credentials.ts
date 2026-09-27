import type {
  CredentialMaterial,
  CredentialMaterialResolver,
} from "@intx/types";

export type SourceCredentialProvenance =
  | {
      readonly kind: "oauth";
      readonly provider: "codex" | "xai";
      readonly profile: string;
    }
  | { readonly kind: "api-key" }
  | { readonly kind: "keyless" };

export interface SourceCredentialRecord {
  readonly provenance: SourceCredentialProvenance;
  readonly material: CredentialMaterial;
}

const cell = new Map<string, SourceCredentialRecord>();

export function registerSourceCredentialRecord(
  credentialId: string,
  record: SourceCredentialRecord,
): void {
  cell.set(credentialId, record);
}

export function registerSourceCredential(
  credentialId: string,
  secret: string,
): void {
  const current = cell.get(credentialId);
  cell.set(credentialId, {
    provenance: current?.provenance ?? { kind: "api-key" },
    material: { ...current?.material, secret },
  });
}

export function rotateSourceCredentialMaterial(
  credentialId: string,
  material: CredentialMaterial,
): void {
  const current = cell.get(credentialId);
  if (current === undefined) {
    throw new Error(
      `Cannot rotate unknown inference credential "${credentialId}".`,
    );
  }
  cell.set(credentialId, { provenance: current.provenance, material });
}

export function readSourceCredentialRecord(
  credentialId: string,
): SourceCredentialRecord {
  const record = cell.get(credentialId);
  if (record === undefined) {
    throw new Error(`Unknown inference credential "${credentialId}".`);
  }
  return record;
}

export const readSourceCredentialMaterial: CredentialMaterialResolver = (
  credentialId: string,
) => readSourceCredentialRecord(credentialId).material;

export function peekSourceCredentialSecret(
  credentialId: string,
): string | undefined {
  return cell.get(credentialId)?.material.secret;
}

export function clearSourceCredentials(): void {
  cell.clear();
}
