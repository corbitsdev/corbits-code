import type { Product } from "../types/index.js";

const products: Product[] = [
  { id: "p1", name: "Widget", price: 9.99, stock: 100 },
  { id: "p2", name: "Gadget", price: 24.99, stock: 50 },
  { id: "p3", name: "Doohickey", price: 4.99, stock: 200 },
];

export function listProducts(): Product[] {
  return products;
}

export function getProduct(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}
