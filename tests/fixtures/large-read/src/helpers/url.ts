export function buildUrl(base: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}
