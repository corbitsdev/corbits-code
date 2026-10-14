import { describe, expect, test } from "bun:test";
import { claudeRow, defaultRow, gptRow, grokRow, museRow } from "./rows.js";
import {
  dsv4CoderBodyRow,
  dsv4LeafRow,
  dsv4PrimaryRow,
  dsv4ReviewerBodyRow,
} from "./dsv4.js";

describe("prompt-variance prompt sizes per family row", () => {
  test("default residual is empty", () => {
    expect(defaultRow.residual.length).toBe(0);
  });

  test("every tuned residual stays under 2000 chars / 3000 bytes", () => {
    for (const row of [museRow, grokRow, claudeRow, gptRow]) {
      expect(row.residual.length).toBeGreaterThan(0);
      expect(row.residual.length).toBeLessThan(2000);
      expect(Buffer.byteLength(row.residual, "utf8")).toBeLessThan(3000);
    }
  });

  test("the grok tool-discipline residual is larger than the muse discipline rules", () => {
    expect(grokRow.residual.length).toBeGreaterThan(museRow.residual.length);
  });

  test("dsv4 rows stay under the same residual budget", () => {
    for (const row of [
      dsv4PrimaryRow,
      dsv4LeafRow,
      dsv4CoderBodyRow,
      dsv4ReviewerBodyRow,
    ]) {
      expect(row.residual.length).toBeGreaterThan(0);
      expect(row.residual.length).toBeLessThan(2000);
      expect(Buffer.byteLength(row.residual, "utf8")).toBeLessThan(3000);
    }
  });

  test("dsv4 leaf role bodies carry NO second identity authority (CL-10674 P2)", () => {
    for (const body of [
      dsv4CoderBodyRow.residual,
      dsv4ReviewerBodyRow.residual,
    ]) {
      expect(body).not.toContain("Identity: agent id");
    }
    expect(dsv4CoderBodyRow.residual.startsWith("You are Coder")).toBe(true);
    expect(dsv4ReviewerBodyRow.residual.startsWith("You are Reviewer")).toBe(
      true,
    );
  });
});
