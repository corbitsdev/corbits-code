import { createMetaResponsesAdapter as createPackageMetaResponsesAdapter } from "@corbits/meta-provider";
import type { AdapterFactory } from "@intx/inference";

// The packaged Meta Responses adapter is host-agnostic; Corbits Code only
// needs the provider id wired into the adapter registry. No host quirks or
// option remaps are required — Meta's Model API speaks the Responses protocol
// natively and the package factory bakes the host-specifics in.
export const createMetaResponsesAdapter: AdapterFactory =
  createPackageMetaResponsesAdapter;
