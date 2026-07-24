#!/usr/bin/env node
/**
 * VibORM CLI
 *
 * Command-line interface for VibORM database operations.
 */

import { Command } from "commander";
import { VIBORM_VERSION } from "../version";
import { migrateCommand } from "./commands/migrate";
import { pushCommand } from "./commands/push";

const program = new Command();

program
  .name("viborm")
  .description("VibORM - Type-safe ORM for PostgreSQL, MySQL and SQLite")
  .version(VIBORM_VERSION);

// Register commands
program.addCommand(pushCommand);
program.addCommand(migrateCommand);

// Parse arguments
program.parse();
