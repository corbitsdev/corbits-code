import { test, expect } from "bun:test";
import { taxFor } from "./tax.js";
import { invoiceTotal } from "./invoice.js";

test("taxFor returns the tax on a subtotal, rounded to whole cents", () => {
  expect(taxFor(10000, 0.1)).toBe(1000);
  expect(taxFor(999, 0.0825)).toBe(82);
});

test("invoiceTotal adds tax to the subtotal", () => {
  expect(invoiceTotal(10000, 0.1)).toBe(11000);
  expect(invoiceTotal(0, 0.2)).toBe(0);
});
