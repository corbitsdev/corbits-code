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

// The material rides process memory long after registration (per-use resolver
// reads, subagent failover chains). Freezing at the cell boundary means every
// downstream holder sees an immutable snapshot: a mutated "material" never
// masquerades as the registered secret, and an attempted header mutation fails
// loudly instead of silently diverging from what the provider sent. Secrets
// are strings; the headers record is the mutable part being contained.
function freezeCredentialMaterial(
  material: CredentialMaterial,
): CredentialMaterial {
  const frozen: CredentialMaterial = {
    ...material,
    ...(material.headers !== undefined
      ? { headers: Object.freeze({ ...material.headers }) }
      : {}),
  };
  return Object.freeze(frozen);
}

export function registerSourceCredentialRecord(
  credentialId: string,
  record: SourceCredentialRecord,
): void {
  cell.set(credentialId, {
    ...record,
    material: freezeCredentialMaterial(record.material),
  });
}

export function rotateSourceCredentialMaterialIfCurrent(
  credentialId: string,
  expected: SourceCredentialRecord,
  material: CredentialMaterial,
): boolean {
  if (cell.get(credentialId) !== expected) return false;
  cell.set(credentialId, {
    provenance: expected.provenance,
    material: freezeCredentialMaterial(material),
  });
  return true;
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

export function findSourceCredentialRecord(
  credentialId: string,
): SourceCredentialRecord | undefined {
  return cell.get(credentialId);
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
