/**
 * `viborm-studio` (`npx @viborm/studio`): open VibORM Studio for the project
 * in the working directory. It finds the `defineConfig` file by itself.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_STUDIO_PORT, runStudio } from "./run";

const HELP = `Usage: viborm-studio [options]

Open VibORM Studio: your schema as a diagram, and every model's rows to browse
and edit through your own VibORM client. The config is found by itself:
viborm.config.ts here or in a parent directory, else a file below that calls
defineConfig from "viborm/config".

Options:
  -c, --config <path>  Use this config instead of searching for one
  -p, --port <port>    Port on 127.0.0.1 (default ${DEFAULT_STUDIO_PORT}, or a free one when taken)
      --no-open        Do not open the browser
      --no-watch       Do not reload when the config or the schema changes
  -h, --help           Show this help
`;

/** The app, built beside the CLI by the package build (`dist/studio.html`). */
const readApp = () =>
  readFileSync(new URL("./studio.html", import.meta.url), "utf8");

export async function main(
  argv: readonly string[],
  app: () => string = readApp
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      open: { type: "boolean", default: true },
      watch: { type: "boolean", default: true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowNegative: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  if (
    port !== undefined &&
    !(Number.isInteger(port) && port >= 0 && port <= 65_535)
  ) {
    throw new Error(
      `--port must be a port between 0 and 65535, not "${values.port}"`
    );
  }
  await runStudio({
    cwd: process.cwd(),
    config: values.config,
    html: app(),
    port,
    open: values.open,
    watch: values.watch,
  });
  return 0;
}
