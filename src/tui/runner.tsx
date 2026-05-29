import { join } from "node:path";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { createAgent, fromToolRunner } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createPosixTools } from "@intx/tools-posix";
import type { Config } from "../config.js";
import { createChatDirector } from "../director.js";
import { buildChatSystemPrompt } from "../prompts.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { consumeStream } from "../stream-consumer.js";
import { loadPricing, startPricingRefresh } from "../pricing-fetcher.js";
import { App } from "./app.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export async function runTUI(config: Config): Promise<number> {
  const emitter = createTUIEventEmitter();
  const pricingCache = await loadPricing();
  const pricingRefresh = startPricingRefresh();

  const posixTools = createPosixTools({
    cwd: config.cwd,
    plugins: [
      pathEscapePlugin(config.cwd),
      authzPlugin(),
      verifyPlugin(),
    ],
  });

  const posixToolList = fromToolRunner(posixTools);
  const allDefinitions = [...posixToolList.map((t) => t.definition)];

  const director = createChatDirector(
    buildChatSystemPrompt(),
    allDefinitions,
  );

  const agent = await createAgent({
    contextDir: join(config.cwd, ".agent-state", "context"),
    sources: [
      {
        id: config.providerName,
        provider: "openai",
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        defaults: { maxTokens: 16384 },
      },
    ],
    defaultSource: config.providerName,
    systemPrompt: buildChatSystemPrompt(),
    tools: posixToolList,
    director,
  });

  const sink = (event: ReactorEmittedEvent): void => {
    emitter.emit("event", event);
  };

  const streamPromise = consumeStream(agent.stream(), sink);

  // Send initial task if provided
  if (config.task.length > 0) {
    agent.send(config.task).catch(() => {});
  }

  const { waitUntilExit } = render(
    <App eventEmitter={emitter} agent={agent} sessionTitle={config.task} modelId={config.model} pricingCache={pricingCache} />,
  );

  await waitUntilExit();

  try {
    await agent.close();
  } catch {
    // ignore
  }
  try {
    await streamPromise;
  } catch {
    // ignore
  }
  await posixTools.dispose();

  return 0;
}
