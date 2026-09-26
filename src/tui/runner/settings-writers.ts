import type { Config } from "../../config/index.js";
import { localSettingsPath } from "../../config/settings.js";
import {
  createGlobalSettingsWriter,
  createLocalSettingsWriter,
} from "../../mcp/add-server.js";

export function createTUISettingsWriters(
  config: Pick<Config, "cwd" | "globalSettingsPath">,
): {
  globalSettingsWriter: ReturnType<typeof createGlobalSettingsWriter>;
  localSettingsWriter: ReturnType<typeof createLocalSettingsWriter>;
} {
  return {
    globalSettingsWriter: createGlobalSettingsWriter(config.globalSettingsPath),
    localSettingsWriter: createLocalSettingsWriter(
      localSettingsPath(config.cwd),
    ),
  };
}
