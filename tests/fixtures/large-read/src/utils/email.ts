export function validateEmail(s: string): boolean {
  return s.includes("@") && s.includes(".");
}
