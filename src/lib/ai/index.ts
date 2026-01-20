import type { AIProvider } from "../types";
import type { Config } from "../config-manager";
import { GoogleProvider } from "./google";
import { OpenAIProvider } from "./openai";
import { AntigravityProvider } from "../antigravity/provider";

export function createProvider(config: Config): AIProvider {
  switch (config.provider) {
    case "google gemini api (需要tier1+层级)":
      return new GoogleProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "antigravity":
      return new AntigravityProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export { GoogleProvider } from "./google";
export { OpenAIProvider } from "./openai";
