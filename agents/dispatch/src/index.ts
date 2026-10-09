// Public surface — re-exports only (no logic). Exports exactly
// `agent, defineAgent, director, tools, systemPrompt, config`. No `workflow`
// export. No Corbits shared package is re-exported; the package's `director`
// structurally satisfies the app's `DirectorPackage` (app-side drift-guard).
export { agent, defineAgent } from "./agent.js";
export { director } from "./director.js";
export { tools } from "./toolset.js";
export { systemPrompt } from "./prompt.js";
export { config } from "./config.js";
