#!/usr/bin/env node

/**
 * aegis — The best colleague you've ever had.
 *
 * Usage:
 *   aegis init       Start a discovery conversation and generate .agentpolicy/
 *   aegis explain    Have Aegis explain the current policy in plain language
 *   aegis validate   Validate policy files against the schemas
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { initCommand } from "../src/commands/init.js";
import { explainCommand } from "../src/commands/explain.js";
import { validateCommand } from "../src/commands/validate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));

const program = new Command();

program
  .name("aegis")
  .description("The best colleague you've ever had — for every AI agent on your team.")
  .version(pkg.version);

program
  .command("init")
  .description("Start a discovery conversation and generate .agentpolicy/")
  .action(async () => {
    await initCommand();
  });

program
  .command("explain")
  .description("Have Aegis explain the current policy in plain language")
  .action(async () => {
    await explainCommand();
  });

program
  .command("validate")
  .description("Validate policy files against the Aegis schemas")
  .action(async () => {
    await validateCommand();
  });

program.parse();