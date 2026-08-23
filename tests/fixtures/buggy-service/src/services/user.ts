import type { User } from "../types/index.js";

const users = new Map<string, User>([
  ["u1", { id: "u1", name: "Alice", email: "alice@example.com" }],
  ["u2", { id: "u2", name: "Bob", email: "bob@example.com" }],
]);

export function listUsers(): User[] {
  return Array.from(users.values());
}

export function getUser(id: string): User | undefined {
  return users.get(id);
}
