import type { Post } from "../types/index.js";

const posts: Map<string, Post> = new Map([
  ["p1", { id: "p1", title: "Hello", body: "World", authorId: "u1" }],
  ["p2", { id: "p2", title: "Second", body: "Post", authorId: "u2" }],
]);

export function listPosts(): Post[] {
  return Array.from(posts.values());
}

export function getPost(id: string): Post | undefined {
  return posts.get(id);
}
