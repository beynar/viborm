/**
 * Schema check CLI.
 *
 * Runs every check a client runs when it is created (identifiers, model
 * identity, relation resolution, selector names), plus the advisory rules,
 * against the schema of the configured client. Run it in a build or CI step to
 * create clients with `skipSchemaValidation: true` at runtime.
 */

import { Command } from "commander";
import { hydrateSchemaNames } from "../../schema/hydration";
import type { SchemaValidationIssue } from "../../schema/validation/types";
import { validateSchema } from "../../schema/validation/validator";
import { finishCli, loadConfig } from "../utils";

interface CheckCliOptions {
  readonly config?: string;
  readonly json?: boolean;
}

// The repair hint, when the issue has one, goes on its own indented line.
const describe = (issue: SchemaValidationIssue): string =>
  [`[${issue.code}] ${issue.message}`, issue.repair]
    .filter(Boolean)
    .join("\n    ");

async function runCheck(options: CheckCliOptions): Promise<void> {
  let client: { $disconnect(): Promise<void> } | undefined;
  let failure: { value: unknown } | undefined;
  try {
    const config = await loadConfig({
      config: options.config,
      skipValidation: true,
    });
    client = config.client;
    const { models } = config;
    // The identifier and identity checks hydration runs, whatever the
    // configured client skipped.
    hydrateSchemaNames(models);
    const result = validateSchema(models);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const issue of result.errors)
        process.stderr.write(`error   ${describe(issue)}\n`);
      for (const issue of result.warnings)
        process.stderr.write(`warning ${describe(issue)}\n`);
      process.stdout.write(
        result.valid
          ? `Schema valid (${Object.keys(models).length} models).\n`
          : `Schema invalid: ${result.errors.length} error(s).\n`
      );
    }
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    failure = { value: error };
  } finally {
    await finishCli(client, failure, options.json);
  }
}

export function createCheckCommand(): Command {
  return new Command("check")
    .description(
      "Validate the schema, so clients can be created with skipSchemaValidation"
    )
    .option("--config <path>", "Path to viborm.config.ts")
    .option("--json", "Print machine-readable JSON")
    .action(runCheck);
}

export const checkCommand = createCheckCommand();
