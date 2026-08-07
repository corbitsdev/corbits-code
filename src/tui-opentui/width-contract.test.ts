import { describe, expect, test } from "bun:test"

import { WIDTH_PROBE, stringWidth } from "../tui/view/height.js"
import {
  checkWidthContract,
  measureRendererWidth,
  widthContractNotice,
} from "./width-contract.js"

describe("the OpenTUI width contract", () => {
  test("OpenTUI's own table agrees with ours under both width methods", () => {
    for (const method of ["wcwidth", "unicode"] as const) {
      expect(measureRendererWidth(WIDTH_PROBE, method)).toBe(stringWidth(WIDTH_PROBE))
    }
  })

  test("a live check against the native table passes", () => {
    const report = checkWidthContract("wcwidth")
    expect(report.agrees).toBe(true)
    expect(widthContractNotice(report)).toBe("")
  })

  test("a table that reads ambiguous glyphs as wide is caught and explained", () => {
    const report = checkWidthContract("unicode", (text) =>
      Bun.stringWidth(text, { ambiguousIsNarrow: false }),
    )
    expect(report.agrees).toBe(false)
    expect(report.renderer).toBeGreaterThan(report.ours)
    expect(widthContractNotice(report)).toContain("ambiguous")
  })

  test("an unmeasurable probe is not treated as a divergence", () => {
    expect(checkWidthContract("wcwidth", () => null).agrees).toBe(true)
  })
})
