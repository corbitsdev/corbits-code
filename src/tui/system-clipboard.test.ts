import { describe, expect, test } from "bun:test";
import type { ClipboardService, ClipboardWriteResult } from "@opentui/core";
import { withMockedModuleDuring } from "../../testkit/mock-module.js";

import {
  createSystemClipboard,
  readSystemClipboardImage,
} from "./system-clipboard.js";

const boundary = {
  capabilities: null,
  copyToClipboardOSC52: () => true,
  clearClipboardOSC52: () => true,
};

function serviceWithResult(result: ClipboardWriteResult): ClipboardService {
  return {
    read: () => Promise.resolve({ status: "unsupported" }),
    writeText: async () => result,
    clear: () =>
      Promise.resolve({
        host: { status: "cleared" },
        terminal: { status: "not-attempted", capability: "unsupported" },
      }),
    dispose: () => Promise.resolve(),
  };
}

describe("system clipboard", () => {
  test("wires the renderer through the OpenTUI clipboard factories", async () => {
    const seen: string[] = [];
    await withMockedModuleDuring(
      import.meta.resolve("@opentui/core"),
      (real: typeof import("@opentui/core")) => ({
        ...real,
        createHostClipboard: () => {
          seen.push("host");
          return {} as ReturnType<typeof real.createHostClipboard>;
        },
        createRendererClipboardAdapter: (renderer: unknown) => {
          seen.push(renderer === boundary ? "terminal" : "terminal-other");
          return {
            remote: false,
            writeText: () => ({ status: "attempted", capability: "supported" }),
            clear: () => ({ status: "attempted", capability: "supported" }),
          };
        },
        createClipboard: () => {
          seen.push("service");
          return serviceWithResult({
            host: { status: "written" },
            terminal: { status: "not-attempted", capability: "unknown" },
          });
        },
      }),
      async () => {
        const { createSystemClipboard: fresh } =
          await import("./system-clipboard.js");
        await fresh(boundary).writeText("hi");
      },
    );
    expect(seen).toEqual(["host", "terminal", "service"]);
  });

  test("resolves when a host helper writes", async () => {
    const service = serviceWithResult({
      host: { status: "written" },
      terminal: { status: "not-attempted", capability: "unknown" },
    });
    await expect(
      createSystemClipboard(boundary, service).writeText("payload"),
    ).resolves.toBeUndefined();
  });

  test("resolves when only the terminal OSC 52 leg attempted", async () => {
    const service = serviceWithResult({
      host: { status: "unsupported" },
      terminal: { status: "attempted", capability: "supported" },
    });
    await expect(
      createSystemClipboard(boundary, service).writeText("payload"),
    ).resolves.toBeUndefined();
  });

  test("rejects when both legs failed so callers flash failure", async () => {
    const service = serviceWithResult({
      host: { status: "failed", error: new Error("no helper") },
      terminal: { status: "local-failure", capability: "supported" },
    });
    await expect(
      createSystemClipboard(boundary, service).writeText("payload"),
    ).rejects.toThrow(/host: failed, terminal: local-failure/);
  });

  test("reads an image representation from the clipboard service", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const seen: string[][] = [];
    const image = await readSystemClipboardImage({
      read: (options) => {
        seen.push([...options.preferredTypes]);
        return Promise.resolve({
          status: "read",
          representation: { mimeType: "image/png", bytes },
        });
      },
    });
    expect(seen[0]).toContain("image/png");
    expect(image).toEqual({ ok: true, mimeType: "image/png", bytes });
  });

  test("maps an empty clipboard read to a miss", async () => {
    const image = await readSystemClipboardImage({
      read: () => Promise.resolve({ status: "empty" }),
    });
    expect(image).toEqual({
      ok: false,
      reason: "no image found on the clipboard",
    });
  });
});
