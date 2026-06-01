export type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
};

export type Order = {
  id: string;
  productId: string;
  quantity: number;
  userId: string;
};

export type RequestContext = {
  method: string;
  path: string;
  body?: unknown;
};

export type Response = {
  status: number;
  body: unknown;
};
