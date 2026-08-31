import { afterEach, describe, expect, test } from "bun:test";

import { createHarness, type Harness } from "./harness.js";
import { runListModal, type ListModalConfig } from "./list-modal.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.destroy();
  harness = undefined;
});

async function mountModal(overrides: Partial<ListModalConfig> = {}): Promise<{
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
    ...overrides,
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

  test("type-to-filter narrows the list and Enter selects the match", async () => {
    const { choice, harness } = await mountModal({ typeToFilter: true });
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("Second session");
    for (const ch of "Second") {
      harness.pressKey(ch);
    }
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("Second session");
    expect(frame).not.toContain("First session");
    harness.pressKey("Enter");
    expect(await choice).toBe("s-2");
  });

  test("type-to-filter no-match Enter stays open", async () => {
    const { choice, harness } = await mountModal({ typeToFilter: true });
    await harness.renderOnce();
    for (const ch of "zzzzz") {
      harness.pressKey(ch);
    }
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("(no matches)");
    harness.pressKey("Enter");
    await harness.renderOnce();
    const afterEnter = harness.captureCharFrame();
    expect(afterEnter).toContain("(no matches)");
    expect(afterEnter).toContain(">");
    for (let i = 0; i < 5; i++) {
      harness.pressKey("Backspace");
    }
    await harness.renderOnce();
    harness.pressKey("Enter");
    expect(await choice).toBe("s-1");
  });
});
