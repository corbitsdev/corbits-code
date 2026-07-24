import { describe, expect, test } from "bun:test";
import { createBlobReader } from "@intx/types/runtime";
import {
  createCompositeBlobReader,
  createLazyBlobReader,
  isBlobNotFoundError,
} from "./lazy-blob-reader.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function readerWith(map: Record<string, string>) {
  return createBlobReader({
    async readBlob(key: string) {
      const value = map[key];
      if (value === undefined) {
        throw new Error(`Blob not found for key: ${JSON.stringify(key)}`);
      }
      return enc.encode(value);
    },
  });
}

describe("createLazyBlobReader", () => {
  test("delegates to the current backing reader", async () => {
    let backing = readerWith({ a: "one" });
    const lazy = createLazyBlobReader(() => backing);
    expect(dec.decode(await lazy.read("tool-output:///a"))).toBe("one");
    backing = readerWith({ a: "two" });
    expect(dec.decode(await lazy.read("tool-output:///a"))).toBe("two");
  });

  test("throws when no backing reader is configured", async () => {
    const lazy = createLazyBlobReader(() => undefined);
    await expect(lazy.read("tool-output:///x")).rejects.toThrow("blob reader is not configured");
  });
});

describe("isBlobNotFoundError", () => {
  test("matches store miss messages", () => {
    expect(isBlobNotFoundError(new Error('Blob not found for key: "x"'))).toBe(true);
    expect(isBlobNotFoundError(new Error("blob reader is not configured"))).toBe(true);
    expect(
      isBlobNotFoundError(new Error('invalid tool-output URI scheme: expected "tool-output:"')),
    ).toBe(false);
    expect(isBlobNotFoundError("Blob not found")).toBe(false);
  });
});

describe("createCompositeBlobReader", () => {
  test("prefers the primary store when the key is present", async () => {
    const child = readerWith({ shared: "from-child", childOnly: "child-only" });
    const parent = readerWith({ shared: "from-parent", parentOnly: "parent-only" });
    const composite = createCompositeBlobReader(
      () => child,
      () => parent,
    );

    expect(dec.decode(await composite.read("tool-output:///shared"))).toBe("from-child");
    expect(dec.decode(await composite.read("tool-output:///childOnly"))).toBe("child-only");
  });

  test("falls back to the parent store for missing child keys (sub-agent re-read)", async () => {
    let child: ReturnType<typeof readerWith> | undefined;
    const parent = readerWith({ parentSpill: "mcp-skill-body-tail" });
    const composite = createCompositeBlobReader(
      () => child,
      () => parent,
    );

    // Before the child agent exists, parent spills are still readable.
    expect(dec.decode(await composite.read("tool-output:///parentSpill"))).toBe(
      "mcp-skill-body-tail",
    );

    child = readerWith({ ownSpill: "child-local" });
    expect(dec.decode(await composite.read("tool-output:///parentSpill"))).toBe(
      "mcp-skill-body-tail",
    );
    expect(dec.decode(await composite.read("tool-output:///ownSpill"))).toBe("child-local");
  });

  test("surfaces a miss when neither store has the key", async () => {
    const composite = createCompositeBlobReader(
      () => readerWith({}),
      () => readerWith({}),
    );
    await expect(composite.read("tool-output:///gone")).rejects.toThrow("Blob not found");
  });

  test("does not fall through on malformed URIs", async () => {
    let parentTouched = false;
    const composite = createCompositeBlobReader(
      () => readerWith({}),
      () =>
        createBlobReader({
          async readBlob() {
            parentTouched = true;
            return enc.encode("nope");
          },
        }),
    );
    await expect(composite.read("file:///not-a-blob")).rejects.toThrow("invalid tool-output URI");
    expect(parentTouched).toBe(false);
  });

  test("works with only a parent (no child yet)", async () => {
    const parent = readerWith({ p: "parent" });
    const composite = createCompositeBlobReader(
      () => undefined,
      () => parent,
    );
    expect(dec.decode(await composite.read("tool-output:///p"))).toBe("parent");
  });

  test("works with only a primary store", async () => {
    const child = readerWith({ c: "child" });
    const composite = createCompositeBlobReader(() => child);
    expect(dec.decode(await composite.read("tool-output:///c"))).toBe("child");
    await expect(composite.read("tool-output:///missing")).rejects.toThrow("Blob not found");
  });
});
