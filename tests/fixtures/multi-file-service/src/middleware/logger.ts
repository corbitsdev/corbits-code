export function logRequest(method: string, path: string): void {
  console.log(`[${new Date().toISOString()}] ${method} ${path}`);
}
