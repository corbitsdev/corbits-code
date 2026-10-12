import { createMetaResponsesAdapter as createPackageMetaResponsesAdapter } from "@corbits/meta-provider";
import type { AdapterFactory } from "@intx/inference";

export const createMetaResponsesAdapter: AdapterFactory =
  createPackageMetaResponsesAdapter;
