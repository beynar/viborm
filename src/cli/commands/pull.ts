/**
 * `viborm pull --json`: an existing database → a schema document.
 *
 * The connection string is `--url`, else `DATABASE_URL` (read from `.env` like
 * every command). The document goes to `--out`, else to stdout, in canonical
 * form; what it does not carry, and where a push of it would change the
 * database, goes to stderr, so stdout stays a document a pipe can parse.
 *
 * `--json` is the only output today. A TypeScript schema will be written from
 * the same document, so the flag names the format rather than defaulting it.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { Command } from "commander";
import { introspectSchema } from "../../migrations/introspect";
import type {
  IntrospectionWarning,
  SkippedObject,
} from "../../migrations/introspect/types";
import { failCli } from "../utils";

interface PullCliOptions {
  readonly url?: string;
  readonly json?: boolean;
  readonly out?: string;
  readonly tables?: readonly string[];
}

function located(item: {
  table?: string | undefined;
  name?: string | undefined;
}) {
  return [item.table, item.name].filter(Boolean).join(".");
}

/** The report a human reads beside the document. */
export function formatPullReport(
  skipped: readonly SkippedObject[],
  warnings: readonly IntrospectionWarning[]
): string {
  const lines: string[] = [];
  if (skipped.length > 0) {
    lines.push(`Not in the document (${skipped.length}):`);
    for (const item of skipped)
      lines.push(`  - ${item.kind} ${located(item)}: ${item.reason}`);
  }
  if (warnings.length > 0) {
    lines.push(`Warnings (${warnings.length}):`);
    for (const warning of warnings)
      lines.push(
        `  - [${warning.kind}] ${located(warning)}: ${warning.message}`
      );
  }
  return lines.length === 0
    ? "The document states the whole database; a push of it plans nothing.\n"
    : `${lines.join("\n")}\n`;
}

async function runPull(options: PullCliOptions): Promise<void> {
  try {
    if (!options.json)
      throw new Error(
        "viborm pull writes a JSON schema document: pass --json. A TypeScript schema is not generated yet."
      );
    const envPath = resolve(process.cwd(), ".env");
    if (existsSync(envPath)) loadEnvFile(envPath);
    const url = options.url ?? process.env.DATABASE_URL;
    if (!url)
      throw new Error(
        "viborm pull needs a connection string: pass --url or set DATABASE_URL."
      );
    const result = await introspectSchema({
      url,
      ...(options.tables === undefined ? {} : { tables: options.tables }),
    });
    const text = `${JSON.stringify(result.document, null, 2)}\n`;
    if (options.out === undefined) process.stdout.write(text);
    else writeFileSync(resolve(process.cwd(), options.out), text);
    process.stderr.write(formatPullReport(result.skipped, result.warnings));
  } catch (error) {
    failCli(error, false);
  }
}

export function createPullCommand(): Command {
  return new Command("pull")
    .description(
      "Read an existing database into a schema document (viborm/schema/json)"
    )
    .option("--json", "Write the JSON schema document")
    .option(
      "--url <url>",
      "Connection string (postgres://, file:, libsql://); defaults to DATABASE_URL"
    )
    .option("--out <path>", "Write the document to this file instead of stdout")
    .option(
      "--tables <names...>",
      "Only these tables (exact physical names, space- or comma-separated)",
      (value: string, previous: string[] | undefined) => [
        ...(previous ?? []),
        ...value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      ]
    )
    .action(runPull);
}

export const pullCommand = createPullCommand();
