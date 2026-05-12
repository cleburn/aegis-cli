import assert from "node:assert/strict";
import test from "node:test";
import { discoverLocalModels } from "../dist/src/llm/local-discovery.js";

test("local model discovery aggregates successful standard servers", async () => {
  const calls = [];
  const discovered = await discoverLocalModels({
    timeoutMs: 10,
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      if (String(input).includes("11434")) {
        return jsonResponse({
          models: [{ name: "gemma3:26b" }, { name: "qwen2.5-coder:32b" }],
        });
      }
      if (String(input).includes("1234")) {
        return jsonResponse({
          object: "list",
          data: [{ id: "lm-studio-model" }],
        });
      }
      if (String(input).includes("8080")) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      throw new Error("connection refused");
    },
  });

  assert.deepEqual(calls, [
    "http://localhost:11434/api/tags",
    "http://localhost:1234/v1/models",
    "http://localhost:8080/v1/models",
    "http://localhost:8000/v1/models",
  ]);
  assert.deepEqual(discovered, [
    {
      source: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "gemma3:26b",
    },
    {
      source: "Ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5-coder:32b",
    },
    {
      source: "LM Studio",
      baseUrl: "http://localhost:1234/v1",
      model: "lm-studio-model",
    },
  ]);
});

test("local model discovery returns empty quickly when all servers fail", async () => {
  const started = Date.now();
  const discovered = await discoverLocalModels({
    timeoutMs: 25,
    fetchImpl: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
  });

  assert.deepEqual(discovered, []);
  assert.ok(Date.now() - started < 3000);
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
