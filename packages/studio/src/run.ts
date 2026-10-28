/**
 * The studio's lifetime: find the project's config, load it, serve the app
 * and the API for its client, open the browser, and load the config again
 * whenever one of the files it compiled changes, until interrupted. A reload
 * that fails keeps the previous client serving and tells the page why.
 */

import { spawn } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import {
  createStudioApi,
  type StudioDrift,
  type StudioStatement,
  type StudioTraceReport,
} from "./api";
import {
  findConfig,
  type Importer,
  importFromProject,
  type LoadedProject,
  loadProject,
  watchFiles,
} from "./config";
import { type StudioServer, startStudioServer } from "./server";
import { defaultStoreDir, projectStore } from "./store";
import { type RecordingTracer, recordingTracer } from "./trace";

/** Where the studio listens unless `--port` says otherwise; a free port when it is taken. */
export const DEFAULT_STUDIO_PORT = 5577;

export interface RunStudioOptions {
  /** Where the search for the config starts. */
  readonly cwd: string;
  /** An explicit config path, relative to `cwd`; skips the search. */
  readonly config: string | undefined;
  /** The app, one HTML document. */
  readonly html: string;
  /** An explicit port: taken or fail. */
  readonly port: number | undefined;
  readonly open: boolean;
  /** Load the config again when a file it compiled changes. */
  readonly watch: boolean;
  /** Read and export only: refuse every create, update and delete. */
  readonly readonly?: boolean;
  /** How the config module is imported; a fresh jiti by default. */
  readonly importer?: Importer;
  /** Where progress is written. */
  readonly print?: (line: string) => void;
  /** Resolves when the studio should stop; SIGINT or SIGTERM by default. */
  readonly stopped?: Promise<void>;
  /** Where each project's views and layout are kept; `~/.viborm/studio` by default. */
  readonly storeDir?: string;
  /** How a module of the project's own `viborm` is imported; from beside its config by default. */
  readonly projectModule?: (specifier: string) => Promise<unknown>;
}

export async function runStudio(options: RunStudioOptions): Promise<void> {
  const print = options.print ?? ((line) => process.stdout.write(`${line}\n`));
  const found = options.config
    ? { path: resolve(options.cwd, options.config), others: [] }
    : findConfig(options.cwd);
  if (!found) {
    throw new Error(
      `No VibORM config found from ${options.cwd}.\n\n` +
        "The studio looks for viborm.config.ts (or .mts, .js, .mjs) here and in\n" +
        "the parent directories, then for a file below that calls defineConfig\n" +
        'from "viborm/config". Create one, or pass --config <path>:\n\n' +
        '  import { defineConfig } from "viborm/config";\n' +
        '  import { client } from "./src/db";\n\n' +
        "  export default defineConfig({ client });\n"
    );
  }
  // The config's relative paths (a SQLite file, `.env`) read as `viborm` commands run beside it read them.
  process.chdir(dirname(found.path));
  const shown = relative(options.cwd, found.path);
  print(`Config: ${shown}`);
  for (const other of found.others) {
    print(
      `  also found ${relative(options.cwd, other)} (use --config to open it)`
    );
  }

  let project = await loadProject(found.path, options.importer);
  // The page's views and layout, kept per project; a write tells every open page to read them again.
  const store = projectStore(
    options.storeDir ?? defaultStoreDir(),
    found.path,
    (name) => server.broadcast("store", { name })
  );
  // The project's own migrations and instrumentation: what `viborm push` would do, and the SQL a query runs.
  const fromProject =
    options.projectModule ??
    ((specifier: string) => importFromProject(found!.path, specifier));
  const tools = { store, ...projectTools(fromProject) };
  const serving = (loaded: LoadedProject) =>
    studioApiOf(loaded, found!.path, options.readonly === true, tools);
  let api = serving(project);
  const server = await listen(options, (request) => api.handle(request));
  print(
    `VibORM Studio is running on ${server.url} (${api.schema.dialect}, ${api.schema.models.length} models${api.schema.readonly ? ", read-only" : ""})`
  );

  let stopWatching = (): void => undefined;
  const watchProject = () => {
    stopWatching = watchFiles(project.files, () => {
      reload();
    });
  };
  let revision = 0;
  async function reload() {
    try {
      const next = await loadProject(found!.path, options.importer);
      const nextApi = serving(next);
      const previous = project;
      project = next;
      api = nextApi;
      revision += 1;
      await previous.config.client.$disconnect().catch(() => undefined);
      print(`Reloaded ${shown}: ${nextApi.schema.models.length} models`);
      server.broadcast("schema", { revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      print(`Reload failed, still serving the previous schema:\n${message}`);
      server.broadcast("error", { message });
    } finally {
      stopWatching();
      watchProject();
    }
  }
  if (options.watch) {
    watchProject();
    print(
      `Watching ${project.files.length} files: saving one reloads the schema.`
    );
  }
  print("Press Ctrl+C to stop.");
  if (options.open) openBrowser(server.url);

  await (options.stopped ?? interrupted());
  stopWatching();
  await server.close();
  await project.config.client.$disconnect();
}

const studioApiOf = (
  project: LoadedProject,
  path: string,
  readonly: boolean,
  tools: Pick<
    Parameters<typeof createStudioApi>[0],
    "store" | "drift" | "trace"
  >
) =>
  createStudioApi({
    client: project.config.client,
    models: project.config.models,
    dialect: String(Reflect.get(project.config.driver, "dialect")),
    readonly,
    project: path,
    ...tools,
  });

type Migrations = {
  createMigrationClient(client: object): {
    push(options: { dryRun: true }): Promise<{
      outcome: "planned" | "noop";
      destructive: boolean;
      operations: readonly { label: string; risk: string }[];
      statements: readonly { sql: string }[];
    }>;
  };
};
type Instrumentation = {
  instrumentation(options: {
    logging: {
      query: (event: StudioStatement) => void;
      includeSql: true;
      includeParams: true;
    };
    tracing: {
      tracer: RecordingTracer;
      includeSql: true;
      includeParams: true;
    };
  }): unknown;
};

/** What the studio asks of the project's own `viborm`: a dry-run push, and the SQL each statement runs. */
function projectTools(fromProject: (specifier: string) => Promise<unknown>) {
  return {
    async drift(client: object): Promise<StudioDrift> {
      const { createMigrationClient } = (await fromProject(
        "viborm/migrations"
      )) as Migrations;
      const preview = await createMigrationClient(client).push({
        dryRun: true,
      });
      if (preview.outcome === "noop") return { state: "in-sync" };
      return {
        state: "drift",
        destructive: preview.destructive,
        operations: preview.operations.map(({ label, risk }) => ({
          label,
          risk,
        })),
        statements: preview.statements.map(({ sql }) => sql),
      };
    },
    async trace(client: object, report: StudioTraceReport) {
      const { instrumentation } = (await fromProject(
        "viborm/instrumentation"
      )) as Instrumentation;
      const extend = Reflect.get(client, "$extends") as (
        extension: unknown
      ) => object;
      return extend.call(
        client,
        instrumentation({
          logging: {
            query: ({ sql, params, duration }) =>
              report.statement({ sql, params, duration }),
            includeSql: true,
            includeParams: true,
          },
          tracing: {
            tracer: recordingTracer(report.span),
            includeSql: true,
            includeParams: true,
          },
        })
      );
    },
  };
}

async function listen(
  options: RunStudioOptions,
  handle: Parameters<typeof startStudioServer>[0]["handle"]
): Promise<StudioServer> {
  const { html } = options;
  const port = options.port ?? DEFAULT_STUDIO_PORT;
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
    // No browser to open: the address is printed above.
  }
}
