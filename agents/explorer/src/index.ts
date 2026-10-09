// Public surface — re-exports only, so the package imports no Corbits code
// (the app asserts the director contract in-tree via drift-guard). No `workflow`
// export: workflows consume `agent`.
export { agent, defineAgent } from "./agent.js";
export { director } from "./director.js";
export { tools } from "./toolset.js";
export { systemPrompt } from "./prompt.js";
export { config } from "./config.js";
