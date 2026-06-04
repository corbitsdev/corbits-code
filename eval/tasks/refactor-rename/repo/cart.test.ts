import { test, expect } from "bun:test";
import { formatMoney } from "./format.js";
import { cartLine, cartTotal } from "./cart.js";

test("formatMoney formats cents as dollars", () => {
  expect(formatMoney(1050)).toBe("$10.50");
});

test("callers use the renamed function", () => {
  expect(cartLine("Book", 1999)).toBe("Book: $19.99");
  expect(cartTotal(2500)).toBe("Total $25.00");
});
