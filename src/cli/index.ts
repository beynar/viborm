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
import { pushCommand } from "./commands/push";
import { studioCommand } from "./commands/studio";

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
program.addCommand(studioCommand);

// Parse arguments
try {
  await program.parseAsync();
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "CLI failed"}\n`
  );
  process.exitCode = 1;
}
