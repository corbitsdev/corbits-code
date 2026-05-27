import { handleUsers } from "./routes/user.js";
import { handlePosts } from "./routes/post.js";

export function handleRequest(method: string, path: string): string {
  if (path.startsWith("/users")) {
    return handleUsers(method, path);
  }
  if (path.startsWith("/posts")) {
    return handlePosts(method, path);
  }
  return "{\"error\":\"not found\"}";
}
