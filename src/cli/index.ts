#!/usr/bin/env node
/**
 * VibORM CLI
 *
 * Command-line interface for VibORM database operations.
 */

import { Command } from "commander";
import { registerEveryMigrationDriver } from "../migrations/dialects/every";
import { VIBORM_VERSION } from "../version";
import { checkCommand } from "./commands/check";
import { migrateCommand } from "./commands/migrate";
import { pullCommand } from "./commands/pull";
import { pushCommand } from "./commands/push";

registerEveryMigrationDriver();

const program = new Command();

program
  .name("viborm")
  .description("VibORM - Type-safe ORM for PostgreSQL, MySQL and SQLite")
  .version(VIBORM_VERSION);

// Register commands
program.addCommand(checkCommand);
program.addCommand(pushCommand);
program.addCommand(migrateCommand);
program.addCommand(pullCommand);

// Parse arguments
try {
  await program.parseAsync();
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "CLI failed"}\n`
  );
  process.exitCode = 1;
}

// The command settled and its client was closed (`runCli`): the process ends
// here, whatever a driver left open. A socket a server never finishes closing
// (SurrealDB Cloud does not answer a WebSocket's closing handshake) otherwise
// kept `push` alive for good after it had printed its outcome. What was
// written goes out first.
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
process.exit();
