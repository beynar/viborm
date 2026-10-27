import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  makeTempProject,
  type TempProject,
} from "@tests/contracts/public-client/cli/_harness";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_STUDIO_PORT, runStudio } from "../src/run";

const spawned = vi.hoisted(() => ({
  calls: [] as [string, string[]][],
  fail: false,
}));
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    spawned.calls.push([command, args]);
    if (spawned.fail) throw new Error("no spawn");
    return { on: () => undefined, unref: () => undefined };
  },
}));

const SQLITE3 = pathToFileURL(
  join(SOURCE_ROOT, "drivers/sqlite3/index.ts")
).href;
const SCHEMA = pathToFileURL(join(SOURCE_ROOT, "schema/index.ts")).href;
const HTML = "<!doctype html><title>VibORM Studio</title>";
const SERVING = /http:\/\/127\.0\.0\.1:\d+/;
const WATCHING = /Watching \d+ files/;
const HOW_TO_CONFIGURE =
  /No VibORM config found[\s\S]*export default defineConfig\(\{ client \}\)/;

/** A project whose config imports its schema from a file of its own. */
function writeProject(dir: string, models: string) {
  writeFileSync(
    join(dir, "schema.ts"),
    `import { s } from ${JSON.stringify(SCHEMA)};\n${models}\n`
  );
  writeFileSync(
    join(dir, "viborm.config.ts"),
    `import { createClient } from ${JSON.stringify(SQLITE3)};
import { schema } from "./schema";
export const client = createClient({ schema, dataDir: ":memory:" });
export default { client };
`
  );
}
const NOTE = `export const note = s.model({ id: s.int().id(), text: s.string() });
export const schema = { note };`;
const NOTE_AND_TAG = `export const note = s.model({ id: s.int().id(), text: s.string() });
export const tag = s.model({ id: s.int().id(), label: s.string() });
export const schema = { note, tag };`;

let project: TempProject;
let output: string[];
let stop: () => void;
let stopped: Promise<void>;
const cwd = process.cwd();

beforeEach(() => {
  project = makeTempProject();
  output = [];
  spawned.calls = [];
  spawned.fail = false;
  stopped = new Promise((resolvePromise) => {
    stop = resolvePromise;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  project.cleanup();
});

const options = (overrides: Partial<Parameters<typeof runStudio>[0]> = {}) => ({
  cwd: project.dir,
  config: undefined,
  html: HTML,
  port: 0,
  open: false,
  watch: false,
  print: (line: string) => output.push(line),
  stopped,
  ...overrides,
});

const printed = () => output.join("\n");
async function serving(): Promise<string> {
  return vi.waitFor(() => {
    const url = SERVING.exec(printed())?.[0];
    if (!url) throw new Error("not serving yet");
    return url;
  });
}
const schemaAt = async (url: string) =>
  (await (await fetch(`${url}/api/schema`)).json()) as {
    dialect: string;
    models: { name: string }[];
    project: string;
  };

function occupiedPort(port: number): Promise<{ close: () => void }> {
  return new Promise((resolvePromise) => {
    const blocker = createServer();
    blocker.once("error", () => resolvePromise({ close: () => undefined }));
    blocker.listen(port, "127.0.0.1", () =>
      resolvePromise({ close: () => blocker.close() })
    );
  });
}

describe("viborm-studio", () => {
  test("finds the config, serves the app and the schema, and stops cleanly", async () => {
    writeProject(project.dir, NOTE);
    const running = runStudio(options({ cwd: join(project.dir) }));
    const url = await serving();
    expect(await (await fetch(url)).text()).toBe(HTML);
    expect(await schemaAt(url)).toMatchObject({
      dialect: "sqlite",
      models: [{ name: "note" }],
      project: join(project.dir, "viborm.config.ts"),
    });
    expect(printed()).toContain("Config: viborm.config.ts");
    expect(printed()).toContain("(sqlite, 1 models)");
    stop();
    await running;
    await expect(fetch(url)).rejects.toThrow();
  });

  test("a schema file saved reloads the client and tells the page", async () => {
    writeProject(project.dir, NOTE);
    const running = runStudio(options({ watch: true }));
    const url = await serving();
    expect(printed()).toMatch(WATCHING);
    const events = await fetch(`${url}/api/events`);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const until = async (text: string) => {
      while (!received.includes(text)) {
        const { value } = await reader.read();
        received += decoder.decode(value);
      }
    };

    writeProject(project.dir, NOTE_AND_TAG);
    await until("event: schema");
    expect(received).toContain('data: {"revision":1}');
    expect((await schemaAt(url)).models.map((model) => model.name)).toEqual([
      "note",
      "tag",
    ]);
    expect(printed()).toContain("Reloaded viborm.config.ts: 2 models");

    // A broken save keeps the last good schema serving and says why.
    writeFileSync(join(project.dir, "schema.ts"), "export const schema = {");
    await until("event: error");
    expect(printed()).toContain(
      "Reload failed, still serving the previous schema"
    );
    expect((await schemaAt(url)).models).toHaveLength(2);
    // So does a schema that throws something other than an Error.
    received = "";
    writeFileSync(join(project.dir, "schema.ts"), 'throw "not today";');
    await until("event: error");
    expect(received).toContain("not today");
    expect((await schemaAt(url)).models).toHaveLength(2);

    await reader.cancel();
    stop();
    await running;
  });

  test("read-only says so and refuses writes", async () => {
    writeProject(project.dir, NOTE);
    const running = runStudio(options({ readonly: true }));
    const url = await serving();
    expect(printed()).toContain("(sqlite, 1 models, read-only)");
    const refused = await fetch(`${url}/api/models/note/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { id: 1, text: "x" } }),
    });
    expect(refused.status).toBe(403);
    stop();
    await running;
  });

  test("an explicit config is read relative to the working directory", async () => {
    mkdirSync(join(project.dir, "db"));
    writeProject(join(project.dir, "db"), NOTE);
    const running = runStudio(options({ config: "db/viborm.config.ts" }));
    await serving();
    expect(printed()).toContain(`Config: ${join("db", "viborm.config.ts")}`);
    expect(process.cwd().endsWith("db")).toBe(true);
    stop();
    await running;
  });

  test("names the other configs a scan found", async () => {
    for (const app of ["api", "web"]) {
      mkdirSync(join(project.dir, app));
      writeProject(join(project.dir, app), NOTE);
    }
    const running = runStudio(options());
    await serving();
    expect(printed()).toContain(`Config: ${join("api", "viborm.config.ts")}`);
    expect(printed()).toContain(
      `also found ${join("web", "viborm.config.ts")} (use --config to open it)`
    );
    stop();
    await running;
  });

  test("without a config it says how to make one", async () => {
    mkdirSync(join(project.dir, ".git"));
    await expect(runStudio(options())).rejects.toThrow(HOW_TO_CONFIGURE);
  });

  test("the default port gives way to a free one; an explicit one does not", async () => {
    writeProject(project.dir, NOTE);
    const blocker = await occupiedPort(DEFAULT_STUDIO_PORT);
    try {
      const running = runStudio(options({ port: undefined }));
      const url = await serving();
      expect(url).not.toContain(`:${DEFAULT_STUDIO_PORT}`);
      stop();
      await running;
      await expect(
        runStudio(options({ port: DEFAULT_STUDIO_PORT }))
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      blocker.close();
    }
  });

  test.each([
    ["darwin", "open"],
    ["win32", "cmd"],
    ["linux", "xdg-open"],
  ] as const)("opens the browser the %s way", async (platform, opener) => {
    writeProject(project.dir, NOTE);
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const running = runStudio(options({ open: true }));
      const url = await serving();
      stop();
      await running;
      expect(spawned.calls).toEqual([[opener, expect.arrayContaining([url])]]);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  test("a browser that cannot be opened leaves the printed address", async () => {
    writeProject(project.dir, NOTE);
    spawned.fail = true;
    const running = runStudio(options({ open: true }));
    await serving();
    stop();
    await running;
    expect(spawned.calls).toHaveLength(1);
  });

  test("stops on SIGINT or SIGTERM by default", async () => {
    writeProject(project.dir, NOTE);
    // Without `print`, progress goes to stdout.
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      output = [];
      const running = runStudio({
        ...options(),
        stopped: undefined,
        print: undefined,
      });
      await serving();
      process.emit(signal);
      await running;
    }
  });
});
