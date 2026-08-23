import { afterEach, describe, expect, test } from "bun:test";

import { createHarness, type Harness } from "./harness.js";
import { runListModal } from "./list-modal.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.destroy();
  harness = undefined;
});

async function mountModal(): Promise<{
  choice: Promise<string | null>;
  harness: Harness;
}> {
  harness = await createHarness({ width: 80, height: 24 });
  const choice = runListModal({
    title: "resume session",
    options: [
      { id: "s-1", label: "First session" },
      { id: "s-2", label: "Second session" },
    ],
    createRenderer: async () => harness!.renderer,
  });
  await harness.renderOnce();
  return { choice, harness };
}

describe("runListModal", () => {
  test("resolves the id of the accepted row", async () => {
    const { choice, harness } = await mountModal();
    harness.pressKey("Enter");
    expect(await choice).toBe("s-1");
  });

  test("arrow navigation selects the next row", async () => {
    const { choice, harness } = await mountModal();
    harness.pressKey("ARROW_DOWN");
    harness.pressKey("Enter");
    expect(await choice).toBe("s-2");
  });

  test("Escape resolves null", async () => {
    const { choice, harness } = await mountModal();
    harness.pressKey("Escape");
    expect(await choice).toBeNull();
  });

  test("Ctrl+C resolves null", async () => {
    const { choice, harness } = await mountModal();
    harness.pressKey("Ctrl+C");
    expect(await choice).toBeNull();
  });

  test("paints the heading and the option labels", async () => {
    const { choice, harness } = await mountModal();
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("First session");
    expect(frame).toContain("Second session");
    harness.pressKey("Escape");
    await choice;
  });
});
