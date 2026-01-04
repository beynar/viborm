#!/usr/bin/env node
/**
 * VibORM CLI
 *
 * Command-line interface for VibORM database operations.
 */

import { Command } from "commander";
import { pushCommand } from "./commands/push";

const program = new Command();

program
  .name("viborm")
  .description("VibORM - Type-safe ORM for PostgreSQL, MySQL and SQLite")
  .version("0.1.0");

// Register commands
program.addCommand(pushCommand);

// Parse arguments
program.parse();
