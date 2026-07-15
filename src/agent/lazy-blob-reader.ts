import type { BlobReader } from "@intx/types/runtime";

/** Blob reader that resolves the backing store on each read (e.g. after agent rebuild). */
export function createLazyBlobReader(get: () => BlobReader | undefined): BlobReader {
  return {
    read: async (uri: string) => {
      const reader = get();
      if (reader === undefined) {
        throw new Error("blob reader is not configured");
      }
      return reader.read(uri);
    },
  };
}