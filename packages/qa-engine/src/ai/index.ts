import type { AiProvider, AiProviderConfig } from "@qa/shared";
import { ClaudeProvider } from "./claude.js";
import { NoneProvider } from "./none.js";
import { OllamaProvider } from "./ollama.js";

export { NoneProvider } from "./none.js";
export { OllamaProvider } from "./ollama.js";
export { ClaudeProvider } from "./claude.js";
export { enrich, passthrough, type EnrichResult } from "./enrich.js";
export { AiGuard, mapLimited, parseJson, retryOnce, withTimeout, type AiStatus } from "./guard.js";

export function createProvider(config: AiProviderConfig): AiProvider {
  switch (config.kind) {
    case "ollama":
      return new OllamaProvider(config);
    case "claude":
      return new ClaudeProvider(config);
    case "none":
    default:
      return new NoneProvider();
  }
}
