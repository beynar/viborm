import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient as createSQLite3Client } from "@drivers/sqlite3";
import { s } from "@schema";
import { createClient } from "@src/client/client";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { queueAnswers } from "@tests/contracts/public-client/cli/_clack";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import Database from "better-sqlite3";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempProject } from "./_harness";

const SHA256 = "a".repeat(64);
const PREFIX = "b".repeat(8);

const boundary = vi.hoisted(() => {
  const disconnect = vi.fn();
  const migrations = {
    apply: vi.fn(),
    baseline: vi.fn(),
    check: vi.fn(),
    down: vi.fn(),
    generate: vi.fn(),
    graph: vi.fn(),
    list: vi.fn(),
    log: vi.fn(),
    reset: vi.fn(),
    resolve: vi.fn(),
    show: vi.fn(),
    status: vi.fn(),
    verify: vi.fn(),
  };
  return {
    client: { $disconnect: disconnect },
    createFsStorageWriter: vi.fn(),
    createMigrationClient: vi.fn(),
    disconnect,
    failCli: vi.fn((error: unknown): never => {
      throw error;
    }),
    loadConfig: vi.fn(),
    loadCliModule: vi.fn(),
    migrations,
  };
});

vi.mock("@src/cli/utils", () => ({
  failCli: boundary.failCli,
  finishCli: async (
    client: { $disconnect(): Promise<void> } | undefined,
    failure: { value: unknown } | undefined
  ) => {
    await client?.$disconnect();
    if (failure) boundary.failCli(failure.value);
  },
  loadConfig: boundary.loadConfig,
  loadCliModule: boundary.loadCliModule,
}));

vi.mock("@src/migrations/client", () => ({
  createMigrationClient: boundary.createMigrationClient,
}));

vi.mock("@src/migrations/storage/fs-estate", () => ({
  createFsStorageWriter: boundary.createFsStorageWriter,
}));

import { createMigrateCommand } from "@src/cli/commands/migrate";

interface Invocation {
  readonly exitCode: typeof process.exitCode;
  readonly output: string;
  readonly thrown: unknown;
}

async function invoke(
  args: readonly string[],
  cwd = "/tmp/viborm-cli-routing"
): Promise<Invocation> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalExitCode = process.exitCode;
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  const program = new Command();
  program.exitOverride();
  program.addCommand(createMigrateCommand());
  let thrown: unknown;
  let exitCode: typeof process.exitCode;

  try {
    await program.parseAsync(["node", "viborm", "migrate", ...args]);
  } catch (error) {
    thrown = error;
  } finally {
    exitCode = process.exitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    cwdSpy.mockRestore();
    process.exitCode = originalExitCode;
  }

  return { exitCode, output: [...stdout, ...stderr].join(""), thrown };
}

function expectCall(
  operation: keyof typeof boundary.migrations,
  expected?: unknown
): void {
  const calls = boundary.migrations[operation].mock.calls;
  // biome-ignore lint/suspicious/noMisplacedAssertion: this shared helper is invoked only from registered tests.
  expect(calls).toHaveLength(1);
  // biome-ignore lint/complexity/noArguments: the call's own arity is the signal — it separates an omitted expectation from one spelled `undefined`.
  // biome-ignore lint/suspicious/noMisplacedAssertion: this shared helper is invoked only from registered tests.
  if (arguments.length === 2) expect(calls[0]?.[0]).toEqual(expected);
}

// Piped by default: a run never prompts unless a test asks for a terminal.
const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}
beforeEach(() => setTty(false));
afterEach(() => {
  if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
  else Reflect.deleteProperty(process.stdin, "isTTY");
});

describe("migrate command routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.loadConfig.mockResolvedValue({
      client: boundary.client,
      migrations: undefined,
    });
    boundary.createFsStorageWriter.mockReturnValue({ kind: "filesystem" });
    boundary.createMigrationClient.mockReturnValue(boundary.migrations);
    boundary.migrations.apply.mockResolvedValue({ outcome: "applied" });
    boundary.migrations.baseline.mockResolvedValue({ outcome: "baselined" });
    boundary.migrations.check.mockResolvedValue({ ok: true });
    boundary.migrations.down.mockResolvedValue({ outcome: "rolled-back" });
    boundary.migrations.generate.mockResolvedValue({ outcome: "published" });
    boundary.migrations.graph.mockResolvedValue({ roots: [], leaves: [] });
    boundary.migrations.list.mockResolvedValue([]);
    boundary.migrations.log.mockResolvedValue(["first", "second"]);
    boundary.migrations.reset.mockResolvedValue({ outcome: "reset" });
    boundary.migrations.resolve.mockResolvedValue({ outcome: "complete" });
    boundary.migrations.show.mockResolvedValue({ stateId: SHA256 });
    boundary.migrations.status.mockResolvedValue({ pending: [] });
    boundary.migrations.verify.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("publishes the exact command vocabulary", () => {
    const command = createMigrateCommand();
    expect(command.commands.map((child) => child.name())).toEqual([
      "generate",
      "check",
      "list",
      "show",
      "graph",
      "status",
      "verify",
      "log",
      "apply",
      "down",
      "baseline",
      "resolve",
      "reset",
    ]);
  });

  it("routes generate options and all parent selector forms", async () => {
    const ordinary = await invoke([
      "generate",
      "--name",
      "initial",
      "--dry-run",
    ]);
    expect(ordinary.thrown).toBeUndefined();
    expect(ordinary.output).toBe("published: No schema changes\n");
    expectCall("generate", {
      name: "initial",
      from: undefined,
      dryRun: true,
    });
    expect(boundary.createFsStorageWriter).toHaveBeenCalledWith(
      "/tmp/viborm-cli-routing/migrations"
    );
    expect(boundary.disconnect).toHaveBeenCalledOnce();

    boundary.migrations.generate.mockClear();
    const virtualRoot = await invoke(["generate", "--from", "empty", "--json"]);
    expect(virtualRoot.output).toContain('\n  "outcome": "published"\n');
    expectCall("generate", {
      name: undefined,
      from: null,
      dryRun: undefined,
    });

    boundary.migrations.generate.mockClear();
    await invoke(["generate", "--from", SHA256]);
    expectCall("generate", {
      name: undefined,
      from: SHA256,
      dryRun: undefined,
    });

    boundary.migrations.generate.mockClear();
    boundary.migrations.show.mockClear();
    await invoke(["generate", "--from", "named-parent"]);
    expect(boundary.migrations.show).toHaveBeenCalledWith({
      name: "named-parent",
    });
    expectCall("generate", {
      name: undefined,
      from: SHA256,
      dryRun: undefined,
    });
  });

  it("uses CLI directory, config directory, storage, and default precedence", async () => {
    await invoke(["generate", "--dir", "command-estate"], "/work/project");
    expect(boundary.createFsStorageWriter).toHaveBeenLastCalledWith(
      "/work/project/command-estate"
    );

    vi.clearAllMocks();
    boundary.loadConfig.mockResolvedValue({
      client: boundary.client,
      migrations: { dir: "config-estate" },
    });
    boundary.createFsStorageWriter.mockReturnValue({ kind: "filesystem" });
    boundary.createMigrationClient.mockReturnValue(boundary.migrations);
    boundary.migrations.generate.mockResolvedValue({ outcome: "published" });
    await invoke(["generate"], "/work/project");
    expect(boundary.createFsStorageWriter).toHaveBeenCalledWith(
      "/work/project/config-estate"
    );

    const storage = { kind: "configured" };
    vi.clearAllMocks();
    boundary.loadConfig.mockResolvedValue({
      client: boundary.client,
      migrations: { dir: "ignored", storage },
    });
    boundary.createMigrationClient.mockReturnValue(boundary.migrations);
    boundary.migrations.generate.mockResolvedValue({ outcome: "published" });
    await invoke(["generate"]);
    expect(boundary.createFsStorageWriter).not.toHaveBeenCalled();
    expect(boundary.createMigrationClient).toHaveBeenCalledWith(
      boundary.client,
      { storage }
    );
  });

  it("selects a parent configuration and passes scope/decisions to generation", async () => {
    const resolve = vi.fn();
    boundary.loadConfig.mockResolvedValue({
      client: boundary.client,
      migrations: { tables: ["users"], resolve },
    });
    const result = await invoke(["--config", "custom.ts", "generate"]);
    expect(result.thrown).toBeUndefined();
    expect(boundary.loadConfig).toHaveBeenCalledWith({ config: "custom.ts" });
    expect(boundary.createMigrationClient).toHaveBeenCalledWith(
      boundary.client,
      { storage: { kind: "filesystem" }, tables: ["users"] }
    );
    expect(boundary.migrations.generate).toHaveBeenCalledWith(
      expect.objectContaining({ resolve })
    );
  });

  it("prints every parent group, rollback warning and labelled SQL", async () => {
    boundary.migrations.generate.mockResolvedValue({
      outcome: "published",
      name: "merge",
      operationsByParent: [
        {
          fromState: SHA256,
          operations: [{ type: "dropTable", tableName: "users" }],
        },
        {
          fromState: PREFIX,
          operations: [
            { type: "dropColumn", tableName: "posts", columnName: "body" },
          ],
        },
      ],
      warnings: ["Backfill unavailable"],
      reviewSql: "-- FORWARD\nDROP TABLE users;\n-- ROLLBACK unavailable",
    });
    const result = await invoke(["generate"]);
    expect(result.output).toContain(`Parent ${SHA256}`);
    expect(result.output).toContain(`Parent ${PREFIX}`);
    expect(result.output).toContain("posts");
    expect(result.output).toContain("warning: Backfill unavailable");
    expect(result.output).toContain("-- ROLLBACK unavailable");
  });

  it("loads a custom author with exact parent IDs", async () => {
    boundary.migrations.graph.mockResolvedValue({ leaves: [SHA256] });
    const manualMigration = {
      requestedForwardBoundary: "transactional",
      parents: [],
    };
    const author = vi.fn().mockResolvedValue(manualMigration);
    boundary.loadCliModule.mockResolvedValue({ default: author });
    expect(
      (await invoke(["generate", "--custom", "data.ts"])).thrown
    ).toBeUndefined();
    expect(author).toHaveBeenCalledWith([SHA256]);
    expect(boundary.migrations.generate).toHaveBeenCalledWith(
      expect.objectContaining({ manualMigration })
    );
  });

  it("routes literal/named custom authors and virtual or explicit parents", async () => {
    const manualMigration = { parents: [] };
    const author = vi.fn().mockResolvedValue(manualMigration);
    const cases = [
      {
        module: { default: manualMigration },
        from: undefined,
        parents: [null],
      },
      { module: { migration: author }, from: undefined, parents: [null] },
      { module: { default: author }, from: SHA256, parents: [SHA256] },
      { module: { default: author }, from: "empty", parents: [null] },
    ];
    boundary.migrations.graph.mockResolvedValue({ leaves: [] });
    for (const entry of cases) {
      boundary.loadCliModule.mockResolvedValue(entry.module);
      author.mockClear();
      boundary.migrations.generate.mockClear();
      const result = await invoke([
        "generate",
        "--custom",
        "manual.ts",
        ...(entry.from ? ["--from", entry.from] : []),
      ]);
      expect(result.thrown).toBeUndefined();
      if (
        typeof ("default" in entry.module
          ? entry.module.default
          : entry.module.migration) === "function"
      )
        expect(author).toHaveBeenCalledWith(entry.parents);
      expect(boundary.migrations.generate).toHaveBeenCalledWith(
        expect.objectContaining({ manualMigration })
      );
    }
    boundary.loadCliModule.mockResolvedValue({});
    expect(
      (await invoke(["generate", "--custom", "invalid.ts"])).thrown
    ).toMatchObject({
      message:
        "A custom migration module must export a default migration or author function",
    });
  });

  it("selects a real named TS author ahead of the loader's synthetic default", async () => {
    const project = makeTempProject();
    try {
      const path = join(project.dir, "named-author.ts");
      writeFileSync(
        path,
        "export const migration = (parents: readonly (string | null)[]) => ({ parents });"
      );
      const actual =
        await vi.importActual<typeof import("@src/cli/utils")>(
          "@src/cli/utils"
        );
      boundary.loadCliModule.mockResolvedValue(
        await actual.loadCliModule(path)
      );
      boundary.migrations.graph.mockResolvedValue({ leaves: [SHA256] });
      expect(
        (await invoke(["generate", "--custom", path])).thrown
      ).toBeUndefined();
      expect(boundary.migrations.generate).toHaveBeenCalledWith(
        expect.objectContaining({ manualMigration: { parents: [SHA256] } })
      );
    } finally {
      project.cleanup();
    }
  });

  it("writes generated review SQL to the requested real file", async () => {
    const project = makeTempProject();
    try {
      const reviewSql = "-- FORWARD\nSELECT 1;\n-- ROLLBACK\nSELECT 2;";
      const path = join(project.dir, "review.sql");
      boundary.migrations.generate.mockResolvedValue({
        outcome: "published",
        reviewSql,
      });
      expect(
        (await invoke(["generate", "--review", path, "--json"])).thrown
      ).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe(reviewSql);
      boundary.migrations.generate.mockResolvedValue({
        outcome: "published",
        sql: "SELECT 3;",
        stateId: SHA256,
        operationsByParent: [{ fromState: null, operations: [] }],
      });
      const result = await invoke(["generate"]);
      expect(result.output).toContain("SELECT 3;");
      expect(result.output).toContain(`(${SHA256})`);
      expect(result.output).toContain("Parent empty:");
    } finally {
      project.cleanup();
    }
  });

  it("renders authenticated state SQL and refuses an absent selected state", async () => {
    const project = makeTempProject();
    const driver = createInMemorySQLite3Driver();
    try {
      const actual = await vi.importActual<
        typeof import("@src/migrations/client")
      >("@src/migrations/client");
      const storage = new MemoryEstateStorage();
      const client = createClient({
        schema: { entry: s.model({ id: s.string().id() }) },
        driver,
      });
      const generated = await actual
        .createMigrationClient(client, { storage })
        .generate({ from: null, name: "review" });
      if (!generated.stateId)
        throw new Error("Expected a published review fixture");
      boundary.createFsStorageWriter.mockReturnValue(storage);
      boundary.migrations.show.mockResolvedValue({
        stateId: generated.stateId,
      });
      const path = join(project.dir, "authenticated-review.sql");
      expect(
        (
          await invoke([
            "show",
            generated.stateId,
            "--sql",
            "--review",
            path,
            "--json",
          ])
        ).thrown
      ).toBeUndefined();
      expect(readFileSync(path, "utf8")).toContain("CREATE TABLE");
      expect(
        (await invoke(["show", generated.stateId, "--sql"])).output
      ).toContain("CREATE TABLE");
      boundary.migrations.show.mockResolvedValue({ stateId: SHA256 });
      expect((await invoke(["show", SHA256, "--sql"])).thrown).toMatchObject({
        message: "The authenticated state SQL is unavailable",
      });
    } finally {
      await driver.disconnect();
      project.cleanup();
    }
  });

  it("refuses conflicting rollback selectors before calling down", async () => {
    const result = await invoke(["down", "--to", SHA256, "--steps", "1"]);
    expect(result.thrown).toMatchObject({
      message: "down accepts --to or --steps, not both",
    });
    expect(boundary.migrations.down).not.toHaveBeenCalled();
  });

  it("previews reset without authorizing effects", async () => {
    expect((await invoke(["reset", "--dry-run"])).thrown).toBeUndefined();
    expectCall("reset", { to: undefined, via: undefined, dryRun: true });
  });

  it("routes every read-only operation and preserves selectors", async () => {
    const check = await invoke(["check", "--json"]);
    expect(check.thrown).toBeUndefined();
    expect(check.output).toContain('  "ok": true');
    expectCall("check");

    await invoke(["list"]);
    expectCall("list");
    await invoke(["graph"]);
    expectCall("graph");
    await invoke(["status"]);
    expectCall("status");
    await invoke(["verify"]);
    expectCall("verify");

    await invoke(["show", SHA256]);
    expect(boundary.migrations.show).toHaveBeenLastCalledWith({ id: SHA256 });
    await invoke(["show", PREFIX]);
    expect(boundary.migrations.show).toHaveBeenLastCalledWith({
      prefix: PREFIX,
    });
    await invoke(["show", "named-state"]);
    expect(boundary.migrations.show).toHaveBeenLastCalledWith({
      name: "named-state",
    });

    const fullLog = await invoke(["log"]);
    expect(fullLog.output).toBe("-\n  first\n-\n  second\n");
    const limitedLog = await invoke(["log", "--limit", "1"]);
    expect(limitedLog.output).toBe("-\n  second\n");
  });

  it("sets failing check and verification exit codes without hiding their JSON", async () => {
    boundary.migrations.check.mockResolvedValue({ ok: false });
    const check = await invoke(["check"]);
    expect(check.thrown).toBeUndefined();
    expect(check.exitCode).toBe(1);
    expect(check.output).toBe("ok: false\n");

    boundary.migrations.verify.mockResolvedValue({ ok: false });
    const verify = await invoke(["verify"]);
    expect(verify.thrown).toBeUndefined();
    expect(verify.exitCode).toBe(1);
    expect(verify.output).toBe("ok: false\n");
  });

  it("keeps numeric selectors as names and refuses retired verbs and options", async () => {
    await invoke(["apply", "--to", "0"]);
    expectCall("apply", {
      to: { name: "0" },
      via: undefined,
      dryRun: undefined,
    });

    for (const verb of ["drop", "squash", "journal", "pending"]) {
      const removed = await invoke([verb]);
      expect(removed.thrown).toBeDefined();
      expect(removed.output).toContain("unknown command");
    }

    const force = await invoke(["apply", "--force"]);
    expect(force.thrown).toBeDefined();
    expect(force.output).toContain("unknown option '--force'");
  });

  it("routes apply, down, and baseline plans without interpreting them", async () => {
    await invoke([
      "apply",
      "--to",
      PREFIX,
      "--via",
      "left",
      "right",
      "--dry-run",
    ]);
    expectCall("apply", {
      to: { prefix: PREFIX },
      via: ["left", "right"],
      dryRun: true,
    });

    boundary.migrations.apply.mockClear();
    await invoke(["apply"]);
    expectCall("apply", {
      to: undefined,
      via: undefined,
      dryRun: undefined,
    });

    await invoke(["down", "--to", "destination", "--dry-run"]);
    expectCall("down", {
      to: { name: "destination" },
      dryRun: true,
    });

    boundary.migrations.down.mockClear();
    await invoke(["down", "--steps", "2"]);
    expectCall("down", { steps: 2, dryRun: undefined });

    boundary.migrations.down.mockClear();
    await invoke([
      "down",
      "--steps",
      "1",
      "--accept-data-loss",
      "--expect-revision",
      "3",
    ]);
    expectCall("down", {
      steps: 1,
      dryRun: undefined,
      resolve: expect.any(Function),
      expectRevision: 3,
    });

    await invoke(["baseline", "--to", SHA256, "--via", "root", "merge"]);
    expectCall("baseline", {
      to: { id: SHA256 },
      via: ["root", "merge"],
    });
  });

  it("routes every resolve outcome and refuses an absent outcome", async () => {
    await invoke(["resolve", "--complete"]);
    expect(boundary.migrations.resolve).toHaveBeenLastCalledWith({
      outcome: "complete",
    });
    await invoke(["resolve", "--rolled-back"]);
    expect(boundary.migrations.resolve).toHaveBeenLastCalledWith({
      outcome: "rolled-back",
    });
    await invoke(["resolve", "--retry"]);
    expect(boundary.migrations.resolve).toHaveBeenLastCalledWith({
      outcome: "retry",
    });

    boundary.migrations.resolve.mockClear();
    const missing = await invoke(["resolve"]);
    expect(missing.thrown).toEqual(
      new Error(
        "resolve requires exactly one of --complete, --rolled-back, or --retry"
      )
    );
    expect(boundary.migrations.resolve).not.toHaveBeenCalled();
  });

  it("routes confirmed reset and lets Commander reject an unconfirmed reset", async () => {
    await invoke([
      "reset",
      "--confirm",
      "--to",
      PREFIX,
      "--via",
      "root",
      "--dry-run",
    ]);
    expectCall("reset", {
      to: { prefix: PREFIX },
      via: ["root"],
      dryRun: true,
    });

    boundary.migrations.reset.mockClear();
    const missing = await invoke(["reset"]);
    expect(missing.thrown).toBeDefined();
    expect(missing.thrown).toEqual(
      new Error("Reset requires --confirm; inspect --dry-run first")
    );
    expect(boundary.migrations.reset).not.toHaveBeenCalled();
  });

  it("contains load and migration failures and always disconnects an acquired client", async () => {
    const loadFailure = new Error("config unavailable");
    boundary.loadConfig.mockRejectedValueOnce(loadFailure);
    const failedLoad = await invoke(["list"]);
    expect(failedLoad.thrown).toBe(loadFailure);
    expect(boundary.failCli).toHaveBeenCalledWith(loadFailure);
    expect(boundary.disconnect).not.toHaveBeenCalled();

    vi.clearAllMocks();
    boundary.loadConfig.mockResolvedValue({
      client: boundary.client,
      migrations: undefined,
    });
    boundary.createFsStorageWriter.mockReturnValue({ kind: "filesystem" });
    boundary.createMigrationClient.mockReturnValue(boundary.migrations);
    const operationFailure = new Error("estate unavailable");
    boundary.migrations.list.mockRejectedValueOnce(operationFailure);
    const failedOperation = await invoke(["list"]);
    expect(failedOperation.thrown).toBe(operationFailure);
    expect(boundary.failCli).toHaveBeenCalledWith(operationFailure);
    expect(boundary.disconnect).toHaveBeenCalledOnce();
  });
});

describe("coverage low value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.loadConfig.mockResolvedValue({
      client: boundary.client,
      migrations: undefined,
    });
    boundary.createFsStorageWriter.mockReturnValue({ kind: "filesystem" });
    boundary.createMigrationClient.mockReturnValue(boundary.migrations);
    boundary.migrations.down.mockResolvedValue({ outcome: "preview" });
    boundary.migrations.generate.mockResolvedValue({ outcome: "preview" });
    boundary.migrations.log.mockResolvedValue([]);
    boundary.migrations.reset.mockResolvedValue({ outcome: "preview" });
  });

  it("covers empty parent text, zero log limit, and absent down/reset selectors", async () => {
    await invoke(["generate", "--from", ""]);
    expectCall("generate", {
      name: undefined,
      from: null,
      dryRun: undefined,
    });

    await invoke(["log", "--limit", "0"]);
    expect(boundary.migrations.log).not.toHaveBeenCalled();

    await invoke(["down"]);
    expectCall("down", { steps: undefined, dryRun: undefined });

    await invoke(["reset", "--confirm"]);
    expectCall("reset", {
      to: undefined,
      via: undefined,
      dryRun: undefined,
    });
  });

  it("lets Commander reject non-positive and unsafe rollback counts", async () => {
    const zero = await invoke(["down", "--steps", "0"]);
    expect(zero.thrown).toBeDefined();
    expect(zero.output).toContain("positive safe integer");

    const unsafe = await invoke([
      "down",
      "--steps",
      String(Number.MAX_SAFE_INTEGER + 1),
    ]);
    expect(unsafe.thrown).toBeDefined();
    expect(unsafe.output).toContain("positive safe integer");
  });
});

describe("migrate generate and down approve destructive changes", () => {
  const row = { id: s.string().id(), name: s.string() };
  const before = { item: s.model({ ...row, legacy: s.string().nullable() }) };
  const after = { item: s.model(row) };
  const renamed = {
    item: s.model({ ...row, successor: s.string().nullable() }),
  };

  async function droppingEstate(next: typeof after | typeof renamed = after) {
    const actual = await vi.importActual<
      typeof import("@src/migrations/client")
    >("@src/migrations/client");
    const driver = createInMemorySQLite3Driver();
    const storage = new MemoryEstateStorage();
    await actual
      .createMigrationClient(createClient({ schema: before, driver }), {
        storage,
      })
      .generate({ name: "initial" });
    vi.clearAllMocks();
    queueAnswers([]);
    boundary.createMigrationClient.mockImplementation(
      actual.createMigrationClient
    );
    boundary.loadConfig.mockResolvedValue({
      client: createClient({ schema: next, driver }),
      migrations: { storage },
    });
    const states = async () => (await storage.listStates()).length;
    return { driver, states };
  }

  it("refuses a drop with V11017 on piped input, and publishes it with --accept-data-loss", async () => {
    const { driver, states } = await droppingEstate();
    try {
      const refused = await invoke(["generate", "--name", "drop"]);
      expect(refused.thrown).toMatchObject({ code: "V11017" });
      expect(await states()).toBe(1);

      const accepted = await invoke([
        "generate",
        "--name",
        "drop",
        "--accept-data-loss",
      ]);
      expect(accepted.thrown).toBeUndefined();
      expect(accepted.output).toContain("published: drop");
      expect(await states()).toBe(2);
    } finally {
      await driver.disconnect();
    }
  });

  it("decides no rename: neither --accept-data-loss nor a terminal answers it", async () => {
    const { driver, states } = await droppingEstate(renamed);
    try {
      const flagged = await invoke([
        "generate",
        "--name",
        "rename",
        "--accept-data-loss",
      ]);
      expect(flagged.thrown).toMatchObject({ code: "V11010" });
      setTty(true);
      const asked = await invoke(["generate", "--name", "rename"]);
      expect(asked.thrown).toMatchObject({ code: "V11010" });
      expect(await states()).toBe(1);
    } finally {
      await driver.disconnect();
    }
  });

  it("rolls back over a populated column only with --accept-data-loss", async () => {
    const actual = await vi.importActual<
      typeof import("@src/migrations/client")
    >("@src/migrations/client");
    // A supplied database outlives the client the command disconnects.
    const db = new Database(":memory:");
    const storage = new MemoryEstateStorage();
    for (const [schema, name] of [
      [after, "initial"],
      [before, "legacy"],
    ] as const) {
      const migrations = actual.createMigrationClient(
        createSQLite3Client({ client: db, schema }),
        { storage }
      );
      await migrations.generate({ name });
      await migrations.apply();
    }
    const client = createSQLite3Client({ client: db, schema: before });
    await client.item.create({ data: { id: "i1", name: "n", legacy: "x" } });
    vi.clearAllMocks();
    boundary.createMigrationClient.mockImplementation(
      actual.createMigrationClient
    );
    boundary.loadConfig.mockResolvedValue({ client, migrations: { storage } });
    const columns = () =>
      (db.prepare(`PRAGMA table_info("item")`).all() as { name: string }[]).map(
        ({ name }) => name
      );
    try {
      const refused = await invoke(["down", "--steps", "1"]);
      expect(refused.thrown).toMatchObject({ code: "V11017" });
      expect(columns()).toContain("legacy");

      const accepted = await invoke([
        "down",
        "--steps",
        "1",
        "--accept-data-loss",
      ]);
      expect(accepted.thrown).toBeUndefined();
      expect(columns()).toEqual(["id", "name"]);
    } finally {
      db.close();
    }
  });

  it("asks once per destructive change on a terminal", async () => {
    const { driver, states } = await droppingEstate();
    setTty(true);
    try {
      queueAnswers([false]);
      const rejected = await invoke(["generate", "--name", "drop"]);
      expect(rejected.thrown).toMatchObject({ code: "V11010" });
      expect(await states()).toBe(1);

      queueAnswers([true]);
      const approved = await invoke(["generate", "--name", "drop"]);
      expect(approved.thrown).toBeUndefined();
      expect(await states()).toBe(2);
    } finally {
      await driver.disconnect();
    }
  });
});
