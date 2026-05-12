import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { AegisExit } from "../abort.js";

const AEGIS_DIR = path.join(os.homedir(), ".aegis");
const CONFIG_PATH = path.join(AEGIS_DIR, "config.json");

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "mistral",
  "custom",
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];
export type StandardProviderId = Exclude<ProviderId, "custom">;
export type GoogleAuthMethod = "apiKey" | "oauth";

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  authMethod?: GoogleAuthMethod;
  reauthRequired?: boolean;
}

export interface AegisConfig {
  version: 1;
  activeProvider: ProviderId;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
}

export type ProviderConfigInput =
  | { provider: Exclude<StandardProviderId, "google">; apiKey: string; model?: string }
  | { provider: "google"; authMethod?: "apiKey"; apiKey: string; model?: string }
  | { provider: "google"; authMethod: "oauth"; model?: string }
  | { provider: "custom"; baseUrl: string; apiKey?: string; model?: string };

export type ActiveProviderConfig = {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  authMethod?: GoogleAuthMethod;
  reauthRequired?: boolean;
  apiKeySource: "env" | "config" | "missing";
  envVar: string;
};

type HiddenInputUpdate = {
  input: string;
  submitted: boolean;
  canceled: boolean;
};

const DEFAULT_PROVIDER: ProviderId = "anthropic";
const LEGACY_API_KEY_FIELD = ["anthropic", "api", "key"].join("_");
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

const PROVIDER_ENV_VARS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  custom: "AEGIS_CUSTOM_API_KEY",
};
const GOOGLE_API_KEY_ENV_VARS = ["GOOGLE_API_KEY", "GEMINI_API_KEY"] as const;

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.includes(value as ProviderId);
}

function isGoogleAuthMethod(value: unknown): value is GoogleAuthMethod {
  return value === "apiKey" || value === "oauth";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyConfig(): AegisConfig {
  return {
    version: 1,
    activeProvider: DEFAULT_PROVIDER,
    providers: {},
  };
}

function providerConfigEquals(a: unknown, b: ProviderConfig | undefined): boolean {
  if (!isRecord(a)) return b === undefined;
  const apiKey = a.apiKey;
  const baseUrl = a.baseUrl;
  const model = a.model;
  const authMethod = a.authMethod;
  const reauthRequired = a.reauthRequired;
  return (
    (typeof apiKey === "string" ? apiKey : undefined) === b?.apiKey &&
    (typeof baseUrl === "string" ? baseUrl : undefined) === b?.baseUrl &&
    (typeof model === "string" ? model : undefined) === b?.model &&
    (isGoogleAuthMethod(authMethod) ? authMethod : undefined) === b?.authMethod &&
    (typeof reauthRequired === "boolean" ? reauthRequired : undefined) ===
      b?.reauthRequired
  );
}

function readRawConfig(): unknown {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {
    // Corrupted config — start fresh
  }
  return null;
}

function normalizeConfig(raw: unknown): { config: AegisConfig; changed: boolean } {
  if (!isRecord(raw)) {
    return { config: emptyConfig(), changed: false };
  }

  const legacyKey = raw[LEGACY_API_KEY_FIELD];
  if (typeof legacyKey === "string" && legacyKey.length > 0) {
    return {
      config: {
        version: 1,
        activeProvider: "anthropic",
        providers: {
          anthropic: { apiKey: legacyKey },
        },
      },
      changed: true,
    };
  }

  const providers: Partial<Record<ProviderId, ProviderConfig>> = {};
  let changed = raw.version !== 1 || !isProviderId(raw.activeProvider);
  if (isRecord(raw.providers)) {
    for (const provider of PROVIDER_IDS) {
      const entry = raw.providers[provider];
      if (!isRecord(entry)) continue;

      const apiKey = entry.apiKey;
      const baseUrl = entry.baseUrl;
      const model = entry.model;
      const authMethod = entry.authMethod;
      const reauthRequired = entry.reauthRequired;
      if (provider === "custom") {
        providers.custom = {
          ...(typeof apiKey === "string" ? { apiKey } : {}),
          ...(typeof baseUrl === "string" ? { baseUrl } : {}),
          ...(typeof model === "string" ? { model } : {}),
        };
      } else if (provider === "google") {
        const normalizedAuthMethod =
          authMethod === "adc"
            ? "oauth"
            : isGoogleAuthMethod(authMethod)
              ? authMethod
              : "apiKey";
        const needsReauth = authMethod === "adc"
          ? true
          : typeof reauthRequired === "boolean"
            ? reauthRequired
            : undefined;
        if (normalizedAuthMethod === "oauth" || typeof apiKey === "string") {
          providers.google = {
            ...(typeof apiKey === "string" ? { apiKey } : {}),
            ...(typeof model === "string" ? { model } : {}),
            authMethod: normalizedAuthMethod,
            ...(needsReauth ? { reauthRequired: needsReauth } : {}),
          };
        }
      } else if (typeof apiKey === "string") {
        providers[provider] = {
          apiKey,
          ...(typeof model === "string" ? { model } : {}),
        };
      }
    }
  } else {
    changed = true;
  }

  if (isRecord(raw.providers)) {
    for (const key of Object.keys(raw.providers)) {
      if (!isProviderId(key)) {
        changed = true;
        continue;
      }
      if (!providerConfigEquals(raw.providers[key], providers[key])) {
        changed = true;
      }
    }
  }

  const activeProvider = isProviderId(raw.activeProvider)
    ? raw.activeProvider
    : DEFAULT_PROVIDER;
  const config: AegisConfig = {
    version: 1,
    activeProvider,
    providers,
  };

  return { config, changed };
}

function writeConfig(config: AegisConfig): void {
  // Explicit 0o700 on the Aegis directory so parent-directory access
  // also stays owner-only. mkdirSync ignores `mode` when the directory
  // already exists, which is why chmodSync follows — it re-hardens on
  // every run, not just creation. Failure here is not fatal (the file
  // chmod below is the critical barrier) but it IS surfaced to stderr
  // so the user can notice a broken permission state on the parent
  // directory instead of discovering it later.
  fs.mkdirSync(AEGIS_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(AEGIS_DIR, 0o700);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    process.stderr.write(
      `[aegis] warning: could not harden ~/.aegis directory permissions to 0700 (${msg}). The API key file itself is still 0600.\n`
    );
  }

  // writeFileSync's `mode` option only applies on file creation; an
  // overwrite of an existing file leaves the old permission bits
  // intact. An explicit chmodSync after the write re-hardens the
  // file to 0o600 on every save so a config file whose permissions
  // were loosened out-of-band cannot silently stay loose.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  fs.chmodSync(CONFIG_PATH, 0o600);
}

export function readConfig(): AegisConfig {
  const { config, changed } = normalizeConfig(readRawConfig());
  if (changed) {
    writeConfig(config);
  }
  return config;
}

export function getProviderEnvVar(provider: ProviderId): string {
  return PROVIDER_ENV_VARS[provider];
}

export function getProviderEnvValue(provider: ProviderId): string | undefined {
  if (provider === "google") {
    for (const envVar of GOOGLE_API_KEY_ENV_VARS) {
      const value = process.env[envVar];
      if (value) return value;
    }
    return undefined;
  }
  return process.env[getProviderEnvVar(provider)];
}

export function getGoogleApiKeyEnvConflicts(): string[] {
  return GOOGLE_API_KEY_ENV_VARS.filter((envVar) => Boolean(process.env[envVar]));
}

export function getActiveProviderConfig(): ActiveProviderConfig {
  const config = readConfig();
  const provider = config.activeProvider;
  const stored = config.providers[provider] ?? {};
  const envVar = getProviderEnvVar(provider);
  const envKey = getProviderEnvValue(provider);
  const authMethod = provider === "google"
    ? stored.authMethod ?? "apiKey"
    : undefined;
  const apiKey = provider === "google" && authMethod === "oauth"
    ? undefined
    : envKey || stored.apiKey;
  const apiKeySource = provider === "google" && authMethod === "oauth"
    ? "missing"
    : envKey ? "env" : stored.apiKey ? "config" : "missing";

  return {
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(provider === "custom" && stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.model ? { model: stored.model } : {}),
    ...(authMethod ? { authMethod } : {}),
    ...(stored.reauthRequired ? { reauthRequired: stored.reauthRequired } : {}),
    apiKeySource,
    envVar,
  };
}

export function saveProviderConfig(
  input: ProviderConfigInput,
  options: { makeActive?: boolean } = {}
): AegisConfig {
  const config = readConfig();
  const providerConfig = providerConfigFromInput(input, config);

  const next: AegisConfig = {
    version: 1,
    activeProvider: options.makeActive === false
      ? config.activeProvider
      : input.provider,
    providers: {
      ...config.providers,
      [input.provider]: providerConfig,
    },
  };

  writeConfig(next);
  return next;
}

function providerConfigFromInput(
  input: ProviderConfigInput,
  config: AegisConfig
): ProviderConfig {
  if (input.provider === "custom") {
    return {
      baseUrl: input.baseUrl,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.model ? { model: input.model } : {}),
    };
  }

  if (input.provider === "google") {
    if (input.authMethod === "oauth") {
      const stored = config.providers.google;
      return {
        ...(stored?.apiKey ? { apiKey: stored.apiKey } : {}),
        ...(input.model ? { model: input.model } : {}),
        authMethod: "oauth",
      };
    }

    return {
      apiKey: input.apiKey,
      ...(input.model ? { model: input.model } : {}),
      authMethod: "apiKey",
    };
  }

  return {
    apiKey: input.apiKey,
    ...(input.model ? { model: input.model } : {}),
  };
}

export function setActiveProvider(provider: ProviderId): AegisConfig {
  const config = readConfig();
  const next: AegisConfig = {
    version: 1,
    activeProvider: provider,
    providers: { ...config.providers },
  };
  writeConfig(next);
  return next;
}

export function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hidden) {
      process.stdout.write(question);
      process.stdout.write("(input hidden - paste your key and press Enter)\n");
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      let input = "";
      // Shared cleanup for both success and abort paths so raw mode
      // and the stdin data listener never leak when the prompt ends.
      // Without this, a Ctrl+C during the hidden prompt would leave
      // the shell in raw mode after process.exit.
      const teardown = (): void => {
        stdin.removeListener("data", onData);
        if (stdin.isTTY && wasRaw !== undefined) {
          stdin.setRawMode(wasRaw);
        }
        rl.close();
      };
      const onData = (char: Buffer) => {
        const update = applyHiddenInputChunk(input, char.toString());
        input = update.input;
        if (update.submitted) {
          teardown();
          process.stdout.write("\n");
          resolve(input);
        } else if (update.canceled) {
          // Ctrl+C — restore terminal and abort via typed exit so
          // init's outer handler can do full cleanup (lock release,
          // transcript write if applicable) before the process ends.
          teardown();
          process.stdout.write("\n");
          reject(new AegisExit(130, "API key entry canceled."));
        }
      };
      stdin.on("data", onData);
    } else {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY && wasRaw) {
        stdin.setRawMode(false);
      }
      const teardown = (): void => {
        if (stdin.isTTY && wasRaw !== undefined) {
          stdin.setRawMode(wasRaw);
        }
        rl.close();
      };
      rl.on("SIGINT", () => {
        teardown();
        reject(new AegisExit(130, "Input canceled."));
      });
      rl.question(question, (answer) => {
        teardown();
        resolve(answer.trim());
      });
    }
  });
}

export function applyHiddenInputChunk(
  input: string,
  chunk: string
): HiddenInputUpdate {
  let next = input;
  for (let index = 0; index < chunk.length; index++) {
    if (chunk.startsWith(BRACKETED_PASTE_START, index)) {
      index += BRACKETED_PASTE_START.length - 1;
      continue;
    }
    if (chunk.startsWith(BRACKETED_PASTE_END, index)) {
      index += BRACKETED_PASTE_END.length - 1;
      continue;
    }

    const char = chunk[index];
    if (char === "\n" || char === "\r") {
      return { input: next, submitted: true, canceled: false };
    }
    if (char === "\u0003") {
      return { input: next, submitted: false, canceled: true };
    }
    if (char === "\u007F" || char === "\b") {
      next = next.slice(0, -1);
      continue;
    }
    next += char;
  }

  return { input: next, submitted: false, canceled: false };
}
