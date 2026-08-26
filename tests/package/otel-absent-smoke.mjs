import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "../..")
);
const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-otel-absent-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", fixtureRoot], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
  const archives = readdirSync(fixtureRoot).filter((name) =>
    name.endsWith(".tgz")
  );
  if (archives.length !== 1) {
    throw new Error(`Expected one packed archive, found ${archives.length}`);
  }
  const archive = join(fixtureRoot, archives[0]);

  const consumerRoot = join(fixtureRoot, "consumer");
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify({
      name: "viborm-otel-absent",
      private: true,
      type: "module",
    })
  );
  execFileSync(
    "pnpm",
    [
      "add",
      "--prod",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
      archive,
    ],
    {
      cwd: consumerRoot,
      stdio: "pipe",
    }
  );

  const packageRoot = join(consumerRoot, "node_modules", "viborm");
  const fixtureRequire = createRequire(join(packageRoot, "package.json"));
  try {
    const resolved = fixtureRequire.resolve("@opentelemetry/api");
    throw new Error(`OpenTelemetry unexpectedly resolved to ${resolved}`);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message.includes("Cannot find module '@opentelemetry/api'")
      )
    ) {
      throw error;
    }
  }

  const { createClient } = await import(
    pathToFileURL(join(packageRoot, "dist", "index.mjs")).href
  );
  const { instrumentation } = await import(
    pathToFileURL(join(packageRoot, "dist", "instrumentation.mjs")).href
  );
  const { Driver } = await import(
    pathToFileURL(join(packageRoot, "dist", "driver.mjs")).href
  );

  class ProbeDriver extends Driver {
    adapter = {};

    constructor() {
      super("sqlite", "otel-absent-probe");
    }

    initClient() {
      return Promise.resolve({});
    }

    closeClient() {
      return Promise.resolve();
    }

    execute() {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }

    executeRaw() {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }

    transaction(client, callback) {
      return callback(client);
    }
  }

  const driver = new ProbeDriver();
  createClient({
    driver,
    schema: {},
  }).$extends(instrumentation({ tracing: true }));

  let successCalls = 0;
  const value = await driver._transaction(async () => {
    successCalls += 1;
    return "success";
  });
  if (value !== "success" || successCalls !== 1) {
    throw new Error("OTel-absent success callback did not run once");
  }

  const failure = new Error("operation failed");
  let failureCalls = 0;
  try {
    await driver._transaction(async () => {
      failureCalls += 1;
      throw failure;
    });
    throw new Error("OTel-absent failure unexpectedly resolved");
  } catch (error) {
    if (error !== failure || failureCalls !== 1) throw error;
  }

  console.log("packed optional OTel peer absence: pass");
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}
