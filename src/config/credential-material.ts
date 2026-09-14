import type { CredentialMaterialResolver } from "@intx/types";

// Every source builder in `src/config` stores secret material directly in
// `credentialId` (API keys, OAuth access tokens, the keyless placeholder), so
// resolving a credential is an identity read. A live credential cell would
// replace this; until then the resolver echoes the id.
export const resolveInlineCredentialMaterial: CredentialMaterialResolver = (
  credentialId,
) => ({ secret: credentialId });
