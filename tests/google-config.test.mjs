import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("Google config migration defaults existing entries to API-key auth", async () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-google-config-"));
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
            apiKey: "stored-google-key",
            model: "gemini-test",
          },
        },
      })
    );

    const moduleUrl = `${pathToFileURL(
      path.resolve("dist/src/config/api-key.js")
    ).href}?googleConfig=${Date.now()}`;
    const { readConfig } = await import(moduleUrl);

    const config = readConfig();
    assert.equal(config.providers.google.authMethod, "apiKey");
    assert.equal(config.providers.google.apiKey, "stored-google-key");

    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(written.providers.google.authMethod, "apiKey");
    assert.deepEqual(readConfig(), config);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
