import { AegisExit } from "../abort.js";
import {
  getActiveProviderConfig,
  resolveApiKey,
  type ActiveProviderConfig,
} from "../config/api-key.js";
import type { LLMProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { MistralProvider } from "./mistral.js";
import {
  CustomProvider,
  DeepSeekProvider,
  OpenAIProvider,
} from "./openai-compatible.js";
import { resolveModelForProvider } from "./models.js";

export async function createActiveProvider(): Promise<LLMProvider> {
  let active = getActiveProviderConfig();
  if (active.provider === "anthropic" && !active.apiKey) {
    const apiKey = await resolveApiKey();
    active = { ...getActiveProviderConfig(), apiKey };
  }

  const model = resolveModelForProvider(active.provider, active.model);

  switch (active.provider) {
    case "anthropic":
      return new AnthropicProvider(requireApiKey(active), model);
    case "openai":
      return new OpenAIProvider(requireApiKey(active), model);
    case "google":
      return new GoogleProvider(requireApiKey(active), model);
    case "deepseek":
      return new DeepSeekProvider(requireApiKey(active), model);
    case "mistral":
      return new MistralProvider(requireApiKey(active), model);
    case "custom":
      if (!active.baseUrl) {
        throw new AegisExit(
          1,
          "Custom provider is active but no base URL is configured."
        );
      }
      return new CustomProvider(active.baseUrl, active.apiKey, model);
  }
}

function requireApiKey(active: ActiveProviderConfig): string {
  if (active.apiKey) return active.apiKey;
  throw new AegisExit(
    1,
    `${providerLabel(active.provider)} is active but no API key is configured. Set ${active.envVar} or choose a different model.`
  );
}

function providerLabel(provider: ActiveProviderConfig["provider"]): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    case "deepseek":
      return "DeepSeek";
    case "mistral":
      return "Mistral";
    case "custom":
      return "Custom";
  }
}
