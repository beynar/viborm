/**
 * CLI Command Factory
 *
 * Provides a standardized way to create CLI commands with shared boilerplate
 * for configuration loading, database connection, error handling, and timing.
 */

import * as p from "@clack/prompts";
import { Command } from "commander";
import { isMigrationError } from "../errors";
import { formatDuration, type LoadedConfig, loadConfig } from "./utils";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Context passed to command handlers.
 */
export interface CommandContext extends LoadedConfig {
  /** Command start time for duration tracking */
  startTime: number;
  /** Spinner instance for showing progress */
  spinner: ReturnType<typeof p.spinner>;
  /** Options passed to the command */
  options: Record<string, unknown>;
}

/**
 * Configuration for creating a command.
 */
export interface CommandConfig {
  /** Command name */
  name: string;
  /** Command description */
  description: string;
  /** Command aliases */
  aliases?: string[];
  /** Command options */
  options?: CommandOption[];
  /** Whether this command requires a database connection */
  requiresConnection?: boolean;
}

/**
 * Command option definition.
 */
export interface CommandOption {
  /** Option flags (e.g., "--dir <dir>", "--dry-run") */
  flags: string;
  /** Option description */
  description: string;
  /** Default value */
  defaultValue?: unknown;
}

/**
 * Command handler function.
 */
export type CommandHandler = (ctx: CommandContext) => Promise<void>;

// =============================================================================
// COMMAND FACTORY
// =============================================================================

/**
 * Creates a standardized CLI command with shared boilerplate.
 *
 * Features:
 * - Automatic configuration loading
 * - Optional database connection management
 * - Standardized error handling
 * - Duration tracking
 * - Spinner for progress indication
 *
 * @example
 * ```ts
 * const myCommand = createCommand(
 *   {
 *     name: "status",
 *     description: "Show migration status",
 *     requiresConnection: true,
 *   },
 *   async (ctx) => {
 *     ctx.spinner.start("Checking status...");
 *     const result = await status(ctx.client);
 *     ctx.spinner.stop("Done");
 *     // Display result
 *   }
 * );
 * ```
 */
export function createCommand(
  config: CommandConfig,
  handler: CommandHandler
): Command {
  const cmd = new Command(config.name).description(config.description);

  // Add aliases
  if (config.aliases) {
    for (const alias of config.aliases) {
      cmd.alias(alias);
    }
  }

  // Add standard --config option
  cmd.option("--config <path>", "Path to viborm.config.ts");

  // Add custom options
  if (config.options) {
    for (const opt of config.options) {
      if (opt.defaultValue !== undefined) {
        cmd.option(opt.flags, opt.description, String(opt.defaultValue));
      } else {
        cmd.option(opt.flags, opt.description);
      }
    }
  }

  // Define action
  cmd.action(async (options) => {
    const startTime = Date.now();
    p.intro(`viborm ${config.name}`);

    const spinner = p.spinner();

    try {
      // Load configuration
      spinner.start("Loading configuration...");
      const loaded = await loadConfig({ config: options.config });
      spinner.stop("Configuration loaded");

      // Connect to database if required
      if (config.requiresConnection && loaded.driver.connect) {
        spinner.start("Connecting to database...");
        await loaded.driver.connect();
        spinner.stop("Connected to database");
      }

      // Create context
      const ctx: CommandContext = {
        ...loaded,
        startTime,
        spinner,
        options,
      };

      // Run handler
      await handler(ctx);

      // Disconnect if we connected
      if (config.requiresConnection && loaded.driver.disconnect) {
        await loaded.driver.disconnect();
      }

      // Show completion
      const duration = Date.now() - startTime;
      p.outro(`Done in ${formatDuration(duration)}`);
    } catch (error) {
      handleCommandError(error, spinner, config.requiresConnection);
    }
  });

  return cmd;
}

/**
 * Handles command errors with proper formatting.
 */
function handleCommandError(
  error: unknown,
  spinner: ReturnType<typeof p.spinner>,
  wasConnected?: boolean
): never {
  // Stop spinner if it's running
  try {
    spinner.stop("Error");
  } catch {
    // Spinner may not be running
  }

  if (isMigrationError(error)) {
    p.log.error(`[${error.code}] ${error.message}`);
  } else if (error instanceof Error) {
    p.log.error(error.message);
  } else {
    p.log.error(String(error));
  }

  process.exit(1);
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Prompts for confirmation before proceeding.
 * Returns false if cancelled.
 */
export async function confirmAction(
  message: string,
  initialValue = true
): Promise<boolean> {
  const result = await p.confirm({
    message,
    initialValue,
  });

  if (p.isCancel(result)) {
    p.cancel("Operation cancelled.");
    return false;
  }

  return result;
}

/**
 * Cancels the current operation and exits.
 */
export function cancelOperation(message = "Operation cancelled."): never {
  p.cancel(message);
  process.exit(0);
}
