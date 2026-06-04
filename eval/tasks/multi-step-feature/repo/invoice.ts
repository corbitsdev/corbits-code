// invoiceTotal currently ignores tax — it should add it.
export function invoiceTotal(subtotalCents: number, rate: number): number {
  return subtotalCents;
}
