/**
 * Connect-path transport: HTTP wins when `type` is `"http"`, or when `type`
 * is unset and `url` is set (even with `command`). Trust-prompt display must
 * use the same predicate so the operator grants the identity `connectMCPServer` opens.
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
