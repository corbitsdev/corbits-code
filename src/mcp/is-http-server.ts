/**
 * Connect-path transport: HTTP wins when `type` is `"http"`, or when `type` is
 * unset and `url` is present — even if `command` is also set. Trust-prompt
 * display must use this same predicate so the operator grants the identity
 * that `connectMCPServer` will actually open.
 */
export function isHttpServer(config: {
  type?: "stdio" | "http";
  url?: string;
}): boolean {
  return (
    config.type === "http" ||
    (config.type === undefined && config.url !== undefined)
  );
}
