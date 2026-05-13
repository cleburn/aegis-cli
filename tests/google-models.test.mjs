import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("Google menu exposes preview and fallback Gemini variants", async () => {
  const { MODEL_IDS, MODEL_OPTIONS } = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/models.js")).href}?googleModels=${Date.now()}-${Math.random()}`
  );

  assert.deepEqual(MODEL_IDS.google, [
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
  ]);
  assert.deepEqual(
    MODEL_OPTIONS.filter((option) => option.provider === "google").map(
      ({ model, label }) => ({ model, label })
    ),
    [
      {
        model: "gemini-3.1-pro-preview",
        label: "Google Gemini 3.1 Pro Preview",
      },
      { model: "gemini-2.5-pro", label: "Google Gemini 2.5 Pro" },
    ]
  );
});

test("stored Google variant survives config normalization and labels", async () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-google-models-"));
  const aegisDir = path.join(home, ".aegis");
  const configPath = path.join(aegisDir, "config.json");

  try {
    process.env.HOME = home;
    fs.mkdirSync(aegisDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        activeProvider: "google",
        providers: {
          google: {
            authMethod: "apiKey",
            apiKey: "google-key",
            model: "gemini-2.5-pro",
          },
        },
      })
    );

    const suffix = `googleModelsConfig=${Date.now()}-${Math.random()}`;
    const config = await import(
      `${pathToFileURL(path.resolve("dist/src/config/api-key.js")).href}?${suffix}`
    );
    const models = await import(
      `${pathToFileURL(path.resolve("dist/src/llm/models.js")).href}?${suffix}`
    );

    const normalized = config.readConfig();
    assert.equal(normalized.providers.google.model, "gemini-2.5-pro");
    assert.equal(config.getActiveProviderConfig().model, "gemini-2.5-pro");
    assert.equal(
      models.modelLabelForProvider("google", "gemini-2.5-pro"),
      "Google Gemini 2.5 Pro"
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
