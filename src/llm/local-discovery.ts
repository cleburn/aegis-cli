export type LocalModelDiscovery = {
  source: string;
  baseUrl: string;
  model: string;
};

type LocalDiscoveryEndpoint = {
  source: string;
  discoveryUrl: string;
  baseUrl: string;
  parser: (json: unknown) => string[];
};

export type LocalDiscoveryOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const LOCAL_DISCOVERY_TIMEOUT_MS = 1_500;

const LOCAL_DISCOVERY_ENDPOINTS: readonly LocalDiscoveryEndpoint[] = [
  {
    source: "Ollama",
    discoveryUrl: "http://localhost:11434/api/tags",
    baseUrl: "http://localhost:11434/v1",
    parser: parseOllamaTags,
  },
  {
    source: "LM Studio",
    discoveryUrl: "http://localhost:1234/v1/models",
    baseUrl: "http://localhost:1234/v1",
    parser: parseOpenAIModels,
  },
  {
    source: "llama.cpp",
    discoveryUrl: "http://localhost:8080/v1/models",
    baseUrl: "http://localhost:8080/v1",
    parser: parseOpenAIModels,
  },
  {
    source: "vLLM",
    discoveryUrl: "http://localhost:8000/v1/models",
    baseUrl: "http://localhost:8000/v1",
    parser: parseOpenAIModels,
  },
] as const;

export async function discoverLocalModels(
  options: LocalDiscoveryOptions = {}
): Promise<LocalModelDiscovery[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? LOCAL_DISCOVERY_TIMEOUT_MS;
  const results = await Promise.all(
    LOCAL_DISCOVERY_ENDPOINTS.map((endpoint) =>
      discoverEndpoint(endpoint, fetchImpl, timeoutMs)
    )
  );
  return results.flat();
}

async function discoverEndpoint(
  endpoint: LocalDiscoveryEndpoint,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<LocalModelDiscovery[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint.discoveryUrl, {
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const models = endpoint.parser(await response.json());
    return models.map((model) => ({
      source: endpoint.source,
      baseUrl: endpoint.baseUrl,
      model,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function parseOllamaTags(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.models)) return [];
  return json.models
    .map((model) =>
      isRecord(model) && typeof model.name === "string" ? model.name : null
    )
    .filter((model): model is string => Boolean(model));
}

function parseOpenAIModels(json: unknown): string[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  return json.data
    .map((model) =>
      isRecord(model) && typeof model.id === "string" ? model.id : null
    )
    .filter((model): model is string => Boolean(model));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
