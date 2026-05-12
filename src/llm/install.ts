import { AegisExit } from "../abort.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { MistralProvider } from "./mistral.js";
import {
  CustomProvider,
  DeepSeekProvider,
  OpenAIProvider,
} from "./openai-compatible.js";
import type { LLMProvider, ProviderValidateResult } from "./provider.js";
import { MODEL_OPTIONS, type ModelOption } from "./models.js";
import type { TerminalUI } from "../ui/terminal.js";
import {
  getActiveProviderConfig,
  getGoogleApiKeyEnvConflicts,
  getProviderEnvVar,
  getProviderEnvValue,
  prompt,
  readConfig,
  saveProviderConfig,
  type ActiveProviderConfig,
  type ProviderConfigInput,
} from "../config/api-key.js";

type InstallResult = "saved" | "pick-again";
type ModelSelection = { option: ModelOption; keepCurrent: boolean };
type SelectModelOptions = {
  current?: ActiveProviderConfig;
  emptyCancels?: boolean;
};
export type ModelSwitchResult =
  | { switched: true; active: ActiveProviderConfig }
  | { switched: false };

const CHOOSE_MODEL_HEADER = "  Choose the model Aegis should use.";

export function hasUsableActiveProvider(active: ActiveProviderConfig): boolean {
  if (active.provider === "custom") {
    return Boolean(active.baseUrl);
  }
  if (active.provider === "google" && active.authMethod === "adc") {
    return true;
  }
  return Boolean(active.apiKey);
}

export async function runProviderInstallFlow(): Promise<ActiveProviderConfig> {
  console.log("");
  console.log(CHOOSE_MODEL_HEADER);

  while (true) {
    const { option } = await selectModel();
    const result = await configureAndValidate(option, { preferStored: false });
    if (result === "saved") {
      return getActiveProviderConfig();
    }
  }
}

export async function confirmProviderForInit(): Promise<ActiveProviderConfig> {
  const active = getActiveProviderConfig();
  if (!hasUsableActiveProvider(active)) {
    return runProviderInstallFlow();
  }

  console.log("");
  if (!hasCurrentModel(active)) {
    console.log(CHOOSE_MODEL_HEADER);
    while (true) {
      const { option } = await selectModel();
      const result = await configureAndValidate(option, {
        preferStored: true,
      });
      if (result === "saved") {
        return getActiveProviderConfig();
      }
    }
  }

  console.log("  Confirm the model Aegis should use for this session.");

  while (true) {
    const selection = await selectModel({ current: active });
    if (selection.keepCurrent) {
      return active;
    }
    const result = await configureAndValidate(selection.option, {
      preferStored: true,
    });
    if (result === "saved") {
      return getActiveProviderConfig();
    }
  }
}

export async function runModelSwitchFlow(
  ui: TerminalUI
): Promise<ModelSwitchResult> {
  const active = getActiveProviderConfig();
  const selection = await selectModelInSession(ui, active);
  if (selection.keepCurrent) {
    ui.showNote("Keeping the current model.");
    return { switched: false };
  }

  const input = inputFromStoredConfig(selection.option);
  if (!input) {
    ui.showNote(
      `${selection.option.label} isn't configured yet. /exit and run aegis init to set up credentials for a new provider.`
    );
    return { switched: false };
  }

  const provider = providerFromInput(input);
  ui.showNote(`Verifying ${selection.option.label}...`);
  const validation = await provider.validate();
  if (!validation.ok) {
    const detail = validation.detail ? ` - ${validation.detail}` : "";
    const reason =
      validation.reason === "auth"
        ? `${provider.name} rejected the configured credentials`
        : `Couldn't verify with ${provider.name}${detail}`;
    ui.showNote(`${reason}. Staying on the current model.`);
    return { switched: false };
  }

  saveProviderConfig(input);
  return { switched: true, active: getActiveProviderConfig() };
}

async function selectModelInSession(
  ui: TerminalUI,
  active: ActiveProviderConfig
): Promise<ModelSelection> {
  const currentIndex = currentModelIndex(active);
  const result = await ui.selectFromMenu({
    title: "Choose a model for the rest of this session.",
    options: MODEL_OPTIONS.map((option, index) => ({
      label: option.label,
      current: index === currentIndex,
    })),
    allowCancel: true,
    cancelLabel: "press Enter or Esc to cancel",
  });

  if ("canceled" in result) {
    const option =
      currentIndex >= 0 ? MODEL_OPTIONS[currentIndex] : MODEL_OPTIONS[0];
    return { option, keepCurrent: true };
  }

  const option = MODEL_OPTIONS[result.index];
  return {
    option,
    keepCurrent: optionIsCurrent(active, option),
  };
}

async function selectModel(
  options: SelectModelOptions = {}
): Promise<ModelSelection> {
  const current = options.current;
  const currentIndex = current ? currentModelIndex(current) : -1;
  console.log("");
  MODEL_OPTIONS.forEach((option, index) => {
    const marker = index === currentIndex ? " (current)" : "";
    console.log(`  ${index + 1}. ${option.label}${marker}`);
  });
  console.log("");

  while (true) {
    const emptyAction = options.emptyCancels
      ? "cancel"
      : currentIndex >= 0
        ? "keep current"
        : null;
    const raw = await prompt(
      emptyAction
        ? `  Select a model by number, or press Enter to ${emptyAction}: `
        : "  Select a model by number: "
    );
    if (!raw && current && options.emptyCancels) {
      const option = currentIndex >= 0
        ? MODEL_OPTIONS[currentIndex]
        : MODEL_OPTIONS[0];
      return { option, keepCurrent: true };
    }
    if (!raw && current && currentIndex >= 0) {
      return {
        option: MODEL_OPTIONS[currentIndex],
        keepCurrent: true,
      };
    }
    if (!raw) {
      throw new AegisExit(130, "Model selection canceled.");
    }

    const selected = Number(raw);
    if (Number.isInteger(selected) && selected >= 1 && selected <= MODEL_OPTIONS.length) {
      const option = MODEL_OPTIONS[selected - 1];
      return {
        option,
        keepCurrent: current ? optionIsCurrent(current, option) : false,
      };
    }

    console.log(`  Enter a number from 1 to ${MODEL_OPTIONS.length}.`);
  }
}

function optionIsCurrent(
  active: ActiveProviderConfig,
  option: ModelOption
): boolean {
  if (active.provider === "custom") return option.provider === "custom";
  return option.provider === active.provider && option.model === active.model;
}

async function configureAndValidate(
  option: ModelOption,
  options: { preferStored: boolean; cancelReturns?: boolean }
): Promise<InstallResult | "canceled"> {
  let input = options.preferStored ? inputFromStoredConfig(option) : null;
  while (true) {
    try {
      input ??= await promptForConfig(option);
    } catch (err) {
      if (options.cancelReturns && err instanceof AegisExit) {
        return "canceled";
      }
      throw err;
    }
    const provider = providerFromInput(input);

    while (true) {
      console.log(`\n  Verifying ${option.label}...`);
      const validation = await provider.validate();
      if (validation.ok) {
        saveProviderConfig(input);
        console.log("  Saved to ~/.aegis/config.json.\n");
        return "saved";
      }

      if (validation.reason === "auth") {
        console.log(
          `  ${provider.name} rejected those credentials. Re-enter them to try again.`
        );
        input = null;
        break;
      }

      const recovery = await promptTransportRecovery(provider, {
        ok: false,
        reason: "transport",
        ...(validation.detail ? { detail: validation.detail } : {}),
      });
      if (recovery === "retry") {
        continue;
      }
      if (recovery === "save") {
        saveProviderConfig(input);
        console.log("  Saved to ~/.aegis/config.json without validation.\n");
        return "saved";
      }
      if (recovery === "pick-again") {
        return "pick-again";
      }
      if (options.cancelReturns) {
        return "canceled";
      }
      throw new AegisExit(130, "Provider setup canceled.");
    }
  }
}

function currentModelIndex(active: ActiveProviderConfig): number {
  const index = MODEL_OPTIONS.findIndex((option) => {
    if (active.provider === "custom") return option.provider === "custom";
    return option.provider === active.provider && option.model === active.model;
  });
  if (index >= 0) return index;
  if (!active.model) {
    return MODEL_OPTIONS.findIndex((option) => option.provider === active.provider);
  }
  return -1;
}

function hasCurrentModel(active: ActiveProviderConfig): boolean {
  return Boolean(active.model);
}

async function promptForConfig(option: ModelOption): Promise<ProviderConfigInput> {
  if (option.provider === "custom") {
    const baseUrl = (await prompt("  Local server base URL: ")).trim();
    if (!baseUrl) {
      throw new AegisExit(130, "Local model server base URL is required.");
    }

    const model = (await prompt("  Local model ID: ")).trim();
    if (!model) {
      throw new AegisExit(130, "Local model ID is required.");
    }

    const apiKey = (await prompt("  API key, if your local server requires one (optional): ", true)).trim();
    return {
      provider: "custom",
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model,
    };
  }
  if (option.provider === "google") {
    return promptForGoogleConfig(option);
  }

  const envVar = getProviderEnvVar(option.provider);
  console.log(`  API key required. You can also use ${envVar} after setup.`);
  const apiKey = (await prompt("  API key: ", true)).trim();
  if (!apiKey) {
    throw new AegisExit(130, `${option.label} API key is required.`);
  }

  return {
    provider: option.provider,
    apiKey,
    model: option.model,
  };
}

async function promptForGoogleConfig(
  option: ModelOption
): Promise<ProviderConfigInput> {
  console.log("  Google Gemini can use gcloud Application Default Credentials or an API key.");
  console.log("  1. Use gcloud authentication");
  console.log("  2. Use a Google API key");
  console.log("");

  while (true) {
    const raw = await prompt("  Google auth method (Enter = gcloud, 2 = API key): ");
    if (!raw || raw === "1") {
      const conflicts = getGoogleApiKeyEnvConflicts();
      if (conflicts.length > 0) {
        console.log(
          `  gcloud authentication cannot be used while ${conflicts.join(
            " or "
          )} is set. Unset those variables or choose option 2 for the API-key path.`
        );
        continue;
      }
      return {
        provider: "google",
        authMethod: "adc",
        model: option.model,
      };
    }
    if (raw === "2") {
      const envVar = getProviderEnvVar("google");
      console.log(`  API key required. You can also use ${envVar} after setup.`);
      const apiKey = (await prompt("  API key: ", true)).trim();
      if (!apiKey) {
        throw new AegisExit(130, `${option.label} API key is required.`);
      }
      return {
        provider: "google",
        authMethod: "apiKey",
        apiKey,
        model: option.model,
      };
    }

    console.log("  Enter 1 for gcloud authentication or 2 for an API key.");
  }
}

async function promptTransportRecovery(
  provider: LLMProvider,
  validation: { ok: false; reason: "transport"; detail?: string }
): Promise<"retry" | "pick-again" | "save" | "abort"> {
  console.log(
    `  Couldn't verify with ${provider.name}${
      validation.detail ? ` - ${validation.detail}` : ""
    }. The credentials were not rejected; the request did not complete.`
  );
  console.log("");
  console.log("  1. Retry validation");
  console.log("  2. Pick a different model");
  console.log("  3. Save anyway");
  console.log("  4. Abort");
  console.log("");

  while (true) {
    const raw = await prompt("  Choose an option: ");
    if (!raw) {
      throw new AegisExit(130, "Provider setup canceled.");
    }
    switch (raw) {
      case "1":
        return "retry";
      case "2":
        return "pick-again";
      case "3":
        return "save";
      case "4":
        return "abort";
      default:
        console.log("  Enter 1, 2, 3, or 4.");
    }
  }
}

function providerFromInput(input: ProviderConfigInput): LLMProvider {
  switch (input.provider) {
    case "anthropic":
      return new AnthropicProvider(input.apiKey, input.model);
    case "openai":
      return new OpenAIProvider(input.apiKey, input.model);
    case "google":
      return input.authMethod === "adc"
        ? new GoogleProvider({ authMethod: "adc", model: input.model })
        : new GoogleProvider(input.apiKey, input.model);
    case "deepseek":
      return new DeepSeekProvider(input.apiKey, input.model);
    case "mistral":
      return new MistralProvider(input.apiKey, input.model);
    case "custom":
      return new CustomProvider(input.baseUrl, input.apiKey, input.model);
  }
}

function inputFromStoredConfig(option: ModelOption): ProviderConfigInput | null {
  const stored = readConfig().providers[option.provider];
  const envKey = getProviderEnvValue(option.provider);

  if (option.provider === "google") {
    if (stored?.authMethod === "adc") {
      return {
        provider: "google",
        authMethod: "adc",
        model: option.model,
      };
    }
    const apiKey = envKey ?? stored?.apiKey;
    if (!apiKey) return null;
    return {
      provider: "google",
      authMethod: "apiKey",
      apiKey,
      model: option.model,
    };
  }

  if (option.provider === "custom") {
    if (!stored?.baseUrl || !stored.model) return null;
    return {
      provider: "custom",
      baseUrl: stored.baseUrl,
      ...(envKey || stored.apiKey ? { apiKey: envKey ?? stored.apiKey } : {}),
      model: stored.model,
    };
  }

  const apiKey = envKey ?? stored?.apiKey;
  if (!apiKey) return null;
  return {
    provider: option.provider,
    apiKey,
    model: option.model,
  };
}
