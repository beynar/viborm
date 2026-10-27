/**
 * The studio command's body: load the config the way every CLI command does,
 * serve the studio for its client, open the browser, and stay up until the
 * process is interrupted.
 */

import { spawn } from "node:child_process";
import { runCli } from "../cli/utils";
import { createStudioApi } from "./api";
import { type StudioServer, startStudioServer } from "./server";

export interface RunStudioOptions {
  readonly config: string | undefined;
  /** The app, one HTML document (`viborm:studio-ui`, or a binary's embedded copy). */
  readonly html: string;
  /** How the config module is imported (`LoadConfigOptions.importer`). */
  readonly importer?: (path: string) => Promise<unknown>;
  /** An explicit port: taken or fail. */
  readonly port: number | undefined;
  /** The port tried first when none was given; a free one when it is taken. */
  readonly defaultPort: number;
  readonly open: boolean;
}

export async function runStudio(options: RunStudioOptions): Promise<void> {
  const load = {
    config: options.config,
    ...(options.importer ? { importer: options.importer } : {}),
  };
  await runCli(load, false, async (config) => {
    const api = createStudioApi({
      client: config.client,
      models: config.models,
      dialect: String(Reflect.get(config.driver, "dialect")),
    });
    const server = await listen(api.handle, options);
    process.stdout.write(
      `VibORM Studio is running on ${server.url} (${api.schema.models.length} models)\nPress Ctrl+C to stop.\n`
    );
    if (options.open) openBrowser(server.url);
    await interrupted();
    await server.close();
  });
}

async function listen(
  handle: Parameters<typeof startStudioServer>[0]["handle"],
  options: RunStudioOptions
): Promise<StudioServer> {
  const { html } = options;
  const port = options.port ?? options.defaultPort;
  try {
    return await startStudioServer({ handle, html, port });
  } catch (error) {
    const taken =
      error instanceof Error && Reflect.get(error, "code") === "EADDRINUSE";
    if (!taken || options.port !== undefined) throw error;
    return startStudioServer({ handle, html, port: 0 });
  }
}

function interrupted(): Promise<void> {
  return new Promise((resolvePromise) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolvePromise();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser to open: the URL is printed above.
  }
}
