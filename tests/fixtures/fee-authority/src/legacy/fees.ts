/**
 * Legacy fee table (pre-billing split).
 * Kept for one-off scripts; checkout no longer imports this module.
 */
export const PLATFORM_FEE_BPS = 175;

export function legacyFee(subtotalCents: number): number {
  return Math.floor((subtotalCents * PLATFORM_FEE_BPS) / 10_000);
}
