import { createServer } from "node:net";
import { createClient } from "@client/client";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

const note = s.model({ id: s.int().id(), text: s.string() });
const schema = { note };

const loaded = vi.hoisted(() => ({
  value: undefined as unknown,
  load: undefined as unknown,
}));
vi.mock("@src/cli/utils", () => ({
  runCli: async (
    load: unknown,
    _json: unknown,
    body: (config: unknown) => Promise<void>
  ) => {
    loaded.load = load;
    return body(loaded.value);
  },
}));

const { runStudio: run } = await import("@src/studio/run");
const { DEFAULT_STUDIO_PORT } = await import("@src/studio/port");
const runStudio = (options: Omit<Parameters<typeof run>[0], "html">) =>
  run({ ...options, html: "<!doctype html><title>VibORM Studio</title>" });

const SERVING = /http:\/\/127\.0\.0\.1:\d+/;

let output: string[];

beforeEach(() => {
  const client = createClient({
    schema,
    driver: createInMemorySQLite3Driver(),
  });
  loaded.value = { client, models: schema, driver: client.$driver };
  spawned.calls = [];
  spawned.fail = false;
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => vi.restoreAllMocks());

/** Run the studio until it has printed its address, fetch it, then interrupt it. */
async function runUntilServing(
  options: Parameters<typeof runStudio>[0],
  signal: NodeJS.Signals = "SIGINT"
) {
  const running = runStudio(options);
  const url = await vi.waitFor(() => {
    const address = SERVING.exec(output.join(""))?.[0];
    if (!address) throw new Error("not serving yet");
    return address;
  });
  const page = await fetch(url);
  process.emit(signal);
  await running;
  return { url, page: await page.text() };
}

/** Hold a port; one some other process already holds is just as taken. */
function occupiedPort(
  port: number
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolvePromise) => {
    const blocker = createServer();
    blocker.once("error", () =>
      resolvePromise({ port, close: () => undefined })
    );
    blocker.listen(port, "127.0.0.1", () =>
      resolvePromise({ port, close: () => blocker.close() })
    );
  });
}

describe("viborm studio", () => {
  test("serves the app for the loaded client and opens the browser", async () => {
    const { url, page } = await runUntilServing({
      config: undefined,
      port: 0,
      defaultPort: 0,
      open: true,
    });
    expect(page).toContain("VibORM Studio");
    expect(output.join("")).toContain("(1 models)");
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "cmd"
          : "xdg-open";
    expect(spawned.calls).toEqual([[opener, expect.arrayContaining([url])]]);
  });

  test("a runtime's own importer reaches the config loader", async () => {
    const importer = (path: string) => import(path);
    await runUntilServing({
      config: "app.config.ts",
      importer,
      port: 0,
      defaultPort: 0,
      open: false,
    });
    expect(loaded.load).toEqual({ config: "app.config.ts", importer });
  });

  test("a browser that cannot be opened leaves the printed address", async () => {
    spawned.fail = true;
    await runUntilServing(
      { config: undefined, port: 0, defaultPort: 0, open: true },
      "SIGTERM"
    );
    expect(spawned.calls).toHaveLength(1);
  });

  test("the default port gives way to a free one; an explicit one does not", async () => {
    const blocker = await occupiedPort(DEFAULT_STUDIO_PORT);
    try {
      const { url } = await runUntilServing({
        config: undefined,
        port: undefined,
        defaultPort: blocker.port,
        open: false,
      });
      expect(url).not.toContain(`:${blocker.port}`);
      expect(spawned.calls).toEqual([]);
      await expect(
        runStudio({
          config: undefined,
          port: blocker.port,
          defaultPort: 0,
          open: false,
        })
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      blocker.close();
    }
  });

  test.each([
    "win32",
    "linux",
  ] as const)("opens the browser the %s way", async (platform) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      await runUntilServing({
        config: undefined,
        port: 0,
        defaultPort: 0,
        open: true,
      });
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    expect(spawned.calls[0]![0]).toBe(
      platform === "win32" ? "cmd" : "xdg-open"
    );
  });
});
