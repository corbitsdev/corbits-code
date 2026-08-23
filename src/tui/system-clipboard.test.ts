import { describe, expect, test } from "bun:test";
import { clipboardCommands, createSystemClipboard, osc52 } from "./system-clipboard.js";

describe("system clipboard", () => {
  test("darwin writes through pbcopy", async () => {
    expect(clipboardCommands("darwin")).toEqual([["pbcopy"]]);
  });

  test("linux tries wayland then X helpers in order", () => {
    expect(clipboardCommands("linux").map((c) => c[0])).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  test("osc52 carries base64 payload between ESC ] and BEL", () => {
    const seq = osc52("hi");
    expect(seq).toBe(`]52;c;${btoa("hi")}`);
  });

  test("stops at the first helper that succeeds", async () => {
    const tried: string[] = [];
    const escapes: string[] = [];
    const clipboard = createSystemClipboard({
      platform: "linux",
      spawn: async (argv) => {
        tried.push(argv[0] as string);
        return argv[0] === "xclip";
      },
      writeEscape: (seq) => escapes.push(seq),
    });
    await clipboard.writeText("payload");
    expect(tried).toEqual(["wl-copy", "xclip"]);
    expect(escapes).toEqual([]);
  });

  test("falls back to OSC 52 when no helper works", async () => {
    const escapes: string[] = [];
    const clipboard = createSystemClipboard({
      platform: "linux",
      spawn: async () => false,
      writeEscape: (seq) => escapes.push(seq),
    });
    await clipboard.writeText("payload");
    expect(escapes).toEqual([osc52("payload")]);
  });
});
