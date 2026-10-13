import pkg from "../package.json" with { type: "json" };

// Injected by `bun build --define process.env.CORBITS_BUILD_INFO='...'` in both
// build and build:bin. Absent in dev/test runs -> plain version fallback.
const BUILD_INFO: string = process.env.CORBITS_BUILD_INFO ?? "";

export const VERSION_PREFIX = `v${typeof pkg.version === "string" ? pkg.version : "0.0.0"}`;
export const DISPLAY_VERSION = BUILD_INFO !== "" ? BUILD_INFO : VERSION_PREFIX;
