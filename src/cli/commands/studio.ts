/**
 * `viborm studio`: browse and edit the configured database in the browser,
 * through the configured client.
 *
 * The studio's server and its prebuilt app are imported only when this
 * command runs, so no other command loads them and no runtime entry can.
 */

import { Command, InvalidArgumentError } from "commander";
import { DEFAULT_STUDIO_PORT } from "../../studio/port";

function parsePort(value: string): number {
  const port = Number(value);
  if (!(Number.isInteger(port) && port >= 0 && port <= 65_535)) {
    throw new InvalidArgumentError("Expected a port between 0 and 65535.");
  }
  return port;
}

export const studioCommand = new Command("studio")
  .description(
    "Open VibORM Studio: the schema as a diagram, and every model's rows to browse and edit through your client"
  )
  .option("-c, --config <path>", "Path to config file")
  .option(
    "-p, --port <port>",
    `Port on 127.0.0.1 (default ${DEFAULT_STUDIO_PORT}, or a free one when taken)`,
    parsePort
  )
  .option("--no-open", "Do not open the browser")
  .action(
    async (options: { config?: string; port?: number; open: boolean }) => {
      const [{ runStudio }, { default: html }] = await Promise.all([
        import("../../studio/run"),
        import("viborm:studio-ui"),
      ]);
      await runStudio({
        config: options.config,
        html,
        port: options.port,
        defaultPort: DEFAULT_STUDIO_PORT,
        open: options.open,
      });
    }
  );
