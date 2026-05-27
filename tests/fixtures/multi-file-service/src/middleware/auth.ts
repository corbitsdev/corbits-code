import type { User } from "../types/index.js";

const mockUsers: Map<string, User> = new Map([
  ["u1", { id: "u1", name: "Alice", email: "alice@example.com" }],
]);

export function getUserByToken(token: string): User | null {
  return mockUsers.get(token) ?? null;
}
