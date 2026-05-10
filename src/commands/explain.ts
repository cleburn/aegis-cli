/**
 * aegis explain
 *
 * Has Aegis read the current .agentpolicy/ and explain it in
 * plain language. Like asking your COO to walk you through
 * the operating procedures.
 */

import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { createActiveProvider } from "../llm/factory.js";
import { explainPolicy } from "../policy/explainer.js";

const AEGIS = chalk.hex("#5B8DEF");

export async function explainCommand(): Promise<void> {
  try {
    const cwd = process.cwd();
    if (!fs.existsSync(path.join(cwd, ".agentpolicy"))) {
      throw new Error("No .agentpolicy/ directory found. Run `aegis init` first.");
    }

    const provider = await createActiveProvider();

    console.log("");
    process.stdout.write(`  ${AEGIS("aegis")}  `);

    await explainPolicy(cwd, provider, (token) => {
      process.stdout.write(token);
    });

    console.log("\n");
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Something went wrong.";
    console.log(`\n  ${msg}\n`);
    process.exit(1);
  }
}
