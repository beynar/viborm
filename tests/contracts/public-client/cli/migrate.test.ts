import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    migrations,
  };
});

vi.mock("@src/cli/utils", () => ({
  failCli: boundary.failCli,
  loadConfig: boundary.loadConfig,
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
    expect(ordinary.output).toBe('{"outcome":"published"}\n');
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
    expect(fullLog.output).toBe('["first","second"]\n');
    const limitedLog = await invoke(["log", "--limit", "1"]);
    expect(limitedLog.output).toBe('["second"]\n');
  });

  it("sets failing check and verification exit codes without hiding their JSON", async () => {
    boundary.migrations.check.mockResolvedValue({ ok: false });
    const check = await invoke(["check"]);
    expect(check.thrown).toBeUndefined();
    expect(check.exitCode).toBe(1);
    expect(check.output).toBe('{"ok":false}\n');

    boundary.migrations.verify.mockResolvedValue({ ok: false });
    const verify = await invoke(["verify"]);
    expect(verify.thrown).toBeUndefined();
    expect(verify.exitCode).toBe(1);
    expect(verify.output).toBe('{"ok":false}\n');
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
      new Error("resolve requires --complete, --rolled-back, or --retry")
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
    expect(missing.output).toContain("required option '--confirm'");
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
    expect(boundary.migrations.log).toHaveBeenCalledOnce();

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
