import { PLATFORM_FEE_BPS } from "./rates.ts";

/**
 * Compute checkout total in cents.
 * Fee = floor(subtotal * PLATFORM_FEE_BPS / 10000).
 *
 * FIXME(rounding): some currencies may need half-up — leave floor for now.
 */
export function platformFeeCents(subtotalCents: number): number {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new Error("subtotalCents must be a non-negative integer");
  }
  return Math.floor((subtotalCents * PLATFORM_FEE_BPS) / 10_000);
}

export function computeCheckoutTotal(subtotalCents: number): number {
  return subtotalCents + platformFeeCents(subtotalCents);
}
