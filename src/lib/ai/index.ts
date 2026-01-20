import type { AIProvider } from "../types";
import type { Config } from "../config-manager";
import { GoogleProvider } from "./google";
import { OpenAIProvider } from "./openai";

export function createProvider(config: Config): AIProvider {
  switch (config.provider) {
    case "google":
      return new GoogleProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export { GoogleProvider } from "./google";
export { OpenAIProvider } from "./openai";
