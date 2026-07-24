/**
 * command-factory.ts — createCommand + confirmAction + cancelOperation.
 *
 * The shipped push/migrate commands do NOT use the factory (they inline their
 * own actions), so we test the factory directly by building throwaway commands
 * and driving them through commander's `parseAsync`, exactly as a real program
 * would. The seam is honest: real commander, real `loadConfig` against a real
 * temp `viborm.config.ts` + pglite driver, real error path.
 *
 * Why this file does NOT import `_harness`: the harness installs its own
 * `@clack/prompts` mock via a hoisted `vi.mock`. This file needs the mock
 * hoisted ABOVE its own `import` of `command-factory` (whose `import * as p from
 * "@clack/prompts"` runs at load) AND needs the mock's namespace members to be
 * `vi.spyOn`-able `vi.fn()`s so it can assert `p.intro` / `p.outro` / `p.cancel`
 * / `p.log.error` call args. Importing `_harness` would (a) resolve the real
 * clack for command-factory before the harness mock registers, and (b) install a
 * competing, non-spyable recording mock. So this file declares its own
 * file-local `vi.mock("@clack/prompts")` of plain `vi.fn()`s. We still mock the
 * *prompt library*, never the factory. The temp-project fixture below is a
 * minimal inline copy of the harness's (same driver/schema URLs, same config
 * shape) — re-invented only because importing `_harness` would re-register the
 * conflicting clack mock.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { vi } from "vitest";

/** Sentinel a queued answer returns to simulate Ctrl-C (isCancel true). */
const CANCEL = Symbol.for("clack:cancel");
let answerQueue: unknown[] = [];

vi.mock("@clack/prompts", () => {
  const nextAnswer = (fallback: unknown) =>
    answerQueue.length > 0 ? answerQueue.shift() : fallback;
  return {
    isCancel: (v: unknown) => v === CANCEL,
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    confirm: vi.fn((opts: { initialValue?: boolean }) =>
      Promise.resolve(nextAnswer(opts.initialValue ?? true))
    ),
    select: vi.fn((opts: { options?: { value: unknown }[] }) =>
      Promise.resolve(nextAnswer(opts.options?.[0]?.value))
    ),
    text: vi.fn((opts: { initialValue?: string }) =>
      Promise.resolve(nextAnswer(opts.initialValue ?? ""))
    ),
    log: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      message: vi.fn(),
    },
    spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  };
});

import * as p from "@clack/prompts";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandContext,
  cancelOperation,
  confirmAction,
  createCommand,
} from "../../src/cli/command-factory";
import { MigrationError } from "../../src/errors/migrations";

// ---------------------------------------------------------------------------
// Temp project fixture (minimal inline copy of _harness — see header note).
// ---------------------------------------------------------------------------

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitError";
  }
}

const SRC = resolve(__dirname, "../../src");
const PGLITE_URL = pathToFileURL(join(SRC, "drivers/pglite/index.ts")).href;
const SCHEMA_URL = pathToFileURL(join(SRC, "schema/index.ts")).href;

const DEFAULT_SCHEMA_BODY = `
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
  });
  const schema = { user };
`;

interface TempProject {
  dir: string;
  configPath: string;
  cleanup(): void;
}

function makeTempProject(): TempProject {
  const dir = mkdtempSync(join(tmpdir(), "viborm-cli-factory-"));
  return {
    dir,
    configPath: join(dir, "viborm.config.ts"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeConfigFixture(project: TempProject): string {
  const source = `import { createClient } from ${JSON.stringify(PGLITE_URL)};
import { s } from ${JSON.stringify(SCHEMA_URL)};

${DEFAULT_SCHEMA_BODY}

export const client = createClient({ schema });

export default { client };
`;
  writeFileSync(project.configPath, source);
  return project.configPath;
}

beforeEach(() => {
  answerQueue = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Local runner: drive a factory-built command through commander with
// process.exit captured.
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number | null;
  thrown: unknown;
}

async function runCommand(
  cmd: Command,
  argv: string[],
  cwd?: string
): Promise<RunResult> {
  const program = new Command();
  program.name("viborm-test");
  program.exitOverride();
  program.addCommand(cmd);

  const origExit = process.exit;
  const origCwd = process.cwd();
  process.exit = ((code?: number): never => {
    throw new ProcessExitError(code ?? 0);
  }) as typeof process.exit;
  if (cwd) {
    process.chdir(cwd);
  }

  let exitCode: number | null = null;
  let thrown: unknown;
  try {
    await program.parseAsync(["node", "viborm-test", ...argv]);
  } catch (err) {
    if (err instanceof ProcessExitError) {
      exitCode = err.code;
    } else {
      thrown = err;
    }
  } finally {
    process.exit = origExit;
    process.chdir(origCwd);
  }
  return { exitCode, thrown };
}

const asFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

interface ConnectableDriver {
  connect?: () => Promise<void>;
  disconnect: () => Promise<void>;
}

async function loadProjectDriver(
  project: TempProject
): Promise<ConnectableDriver> {
  const { loadConfig } = await import("../../src/cli/utils");
  const cwd = process.cwd();
  process.chdir(project.dir);
  try {
    const loaded = await loadConfig({ config: project.configPath });
    return loaded.driver as ConnectableDriver;
  } finally {
    process.chdir(cwd);
  }
}

describe("command-factory: createCommand wiring", () => {
  it("adds the standard --config option", () => {
    const cmd = createCommand({ name: "demo", description: "d" }, async () => {
      // no-op
    });
    const flags = cmd.options.map((o) => o.flags);
    expect(flags).toContain("--config <path>");
  });

  it("adds custom options and registers defaultValue as a string", () => {
    const cmd = createCommand(
      {
        name: "demo",
        description: "d",
        options: [
          { flags: "--dir <dir>", description: "output dir", defaultValue: 5 },
          { flags: "--dry-run", description: "preview only" },
        ],
      },
      async () => {
        // no-op
      }
    );

    const dirOpt = cmd.options.find((o) => o.flags === "--dir <dir>");
    const dryOpt = cmd.options.find((o) => o.flags === "--dry-run");
    expect(dirOpt).toBeDefined();
    expect(dryOpt).toBeDefined();
    // defaultValue is coerced with String(...) before registration.
    expect(dirOpt?.defaultValue).toBe("5");
    // A flag with no defaultValue registers none.
    expect(dryOpt?.defaultValue).toBeUndefined();
  });

  it("registers aliases from config.aliases", () => {
    const cmd = createCommand(
      { name: "generate", description: "d", aliases: ["gen", "g"] },
      async () => {
        // no-op
      }
    );
    expect(cmd.aliases()).toEqual(["gen", "g"]);
  });

  it("sets the command name and description", () => {
    const cmd = createCommand(
      { name: "status", description: "Show migration status" },
      async () => {
        // no-op
      }
    );
    expect(cmd.name()).toBe("status");
    expect(cmd.description()).toBe("Show migration status");
  });
});

describe("command-factory: createCommand action", () => {
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it("loads config, builds a CommandContext, and runs the handler", async () => {
    writeConfigFixture(project);
    let ctx: CommandContext | undefined;

    const cmd = createCommand({ name: "demo", description: "d" }, async (c) => {
      ctx = c;
    });

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(ctx).toBeDefined();
    // Context is the loaded config spread with startTime/spinner/options.
    expect(ctx?.client).toBeDefined();
    expect(ctx?.driver).toBeDefined();
    expect(Object.keys(ctx?.models ?? {})).toContain("user");
    expect(typeof ctx?.startTime).toBe("number");
    expect(ctx?.spinner).toBeDefined();
    expect(typeof ctx?.spinner.start).toBe("function");
    // Parsed options are passed through, including our --config.
    expect(ctx?.options.config).toBe(project.configPath);
  });

  it("emits intro and an outro 'Done in <duration>' on success", async () => {
    writeConfigFixture(project);

    const cmd = createCommand({ name: "demo", description: "d" }, async () => {
      // no-op
    });

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBeNull();
    expect(p.intro).toHaveBeenCalledWith("viborm demo");
    expect(p.outro).toHaveBeenCalledTimes(1);
    expect(String(asFn(p.outro).mock.calls[0]?.[0])).toMatch(/^Done in /);
  });

  it("requiresConnection:true connects before and disconnects after the handler", async () => {
    writeConfigFixture(project);
    const order: string[] = [];

    // loadConfig returns the client/driver singleton cached by the config
    // module's `import()`. Load it once here so we operate on the same driver
    // the factory will connect/disconnect. The base Driver has no `connect`
    // method (it's an optional interface member the factory guards on), so we
    // install one to exercise the connect branch, and spy the real `disconnect`.
    const driver = await loadProjectDriver(project);
    const origConnect = driver.connect;
    driver.connect = vi.fn(async () => {
      order.push("connect");
    });
    const disconnectSpy = vi
      .spyOn(driver, "disconnect")
      .mockImplementation(async () => {
        order.push("disconnect");
      });

    const cmd = createCommand(
      { name: "demo", description: "d", requiresConnection: true },
      async () => {
        order.push("handler");
      }
    );

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBeNull();
    expect(asFn(driver.connect)).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    // connect runs before the handler; disconnect runs after it returns.
    expect(order).toEqual(["connect", "handler", "disconnect"]);

    driver.connect = origConnect;
    disconnectSpy.mockRestore();
  });

  it("requiresConnection:true disconnects when the handler throws", async () => {
    writeConfigFixture(project);
    const order: string[] = [];

    const driver = await loadProjectDriver(project);
    const origConnect = driver.connect;
    driver.connect = vi.fn(async () => {
      order.push("connect");
    });
    const disconnectSpy = vi
      .spyOn(driver, "disconnect")
      .mockImplementation(async () => {
        order.push("disconnect");
      });

    const cmd = createCommand(
      { name: "demo", description: "d", requiresConnection: true },
      async () => {
        order.push("handler");
        throw new Error("boom from handler");
      }
    );

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBe(1);
    expect(asFn(driver.connect)).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["connect", "handler", "disconnect"]);
    expect(p.log.error).toHaveBeenCalledWith("boom from handler");

    driver.connect = origConnect;
    disconnectSpy.mockRestore();
  });

  it("requiresConnection:false (default) does NOT connect or disconnect", async () => {
    writeConfigFixture(project);

    const driver = await loadProjectDriver(project);
    const origConnect = driver.connect;
    driver.connect = vi.fn(async () => {
      // installed so the factory *could* call it — it must not.
    });
    const disconnectSpy = vi.spyOn(driver, "disconnect");

    const cmd = createCommand({ name: "demo", description: "d" }, async () => {
      // no-op
    });

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBeNull();
    // Default requiresConnection is falsy -> neither branch runs.
    expect(asFn(driver.connect)).not.toHaveBeenCalled();
    expect(disconnectSpy).not.toHaveBeenCalled();

    driver.connect = origConnect;
    disconnectSpy.mockRestore();
  });
});

describe("command-factory: createCommand error handling", () => {
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it("handler throwing a plain Error -> p.log.error(message) + exit 1", async () => {
    writeConfigFixture(project);

    const cmd = createCommand({ name: "demo", description: "d" }, async () => {
      throw new Error("boom from handler");
    });

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBe(1);
    expect(result.thrown).toBeUndefined();
    expect(p.log.error).toHaveBeenCalledWith("boom from handler");
  });

  it("handler throwing a MigrationError -> p.log.error('[CODE] message')", async () => {
    writeConfigFixture(project);

    const migErr = new MigrationError("checksum mismatch");
    const cmd = createCommand({ name: "demo", description: "d" }, async () => {
      throw migErr;
    });

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBe(1);
    expect(p.log.error).toHaveBeenCalledWith(
      `[${migErr.code}] checksum mismatch`
    );
  });

  it("handler throwing a non-Error value -> p.log.error(String(value))", async () => {
    writeConfigFixture(project);

    const cmd = createCommand(
      { name: "demo", description: "d" },
      // biome-ignore lint/suspicious/useAwait: intentionally throws a non-Error
      async () => {
        throw "plain string failure";
      }
    );

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBe(1);
    expect(p.log.error).toHaveBeenCalledWith("plain string failure");
  });

  it("config-load failure surfaces through the same error path (exit 1)", async () => {
    // No config at this path: loadConfig throws "Could not find ..." inside the
    // action's try; handleCommandError catches it -> log.error + exit 1.
    const cmd = createCommand({ name: "demo", description: "d" }, async () => {
      // never reached
    });

    const result = await runCommand(
      cmd,
      ["demo", "--config", "/no/such/viborm.config.ts"],
      project.dir
    );

    expect(result.exitCode).toBe(1);
    expect(p.log.error).toHaveBeenCalledTimes(1);
    expect(String(asFn(p.log.error).mock.calls[0]?.[0])).toContain(
      "Could not find VibORM configuration file"
    );
  });

  it("handler clean cancel exits 0 without logging an error", async () => {
    writeConfigFixture(project);

    const cmd = createCommand({ name: "demo", description: "d" }, async () => {
      cancelOperation("bye now");
    });

    const result = await runCommand(
      cmd,
      ["demo", "--config", project.configPath],
      project.dir
    );

    expect(result.exitCode).toBe(0);
    expect(p.cancel).toHaveBeenCalledWith("bye now");
    expect(p.log.error).not.toHaveBeenCalled();
  });
});

describe("command-factory: confirmAction", () => {
  it("returns the confirm answer (true)", async () => {
    answerQueue = [true];
    const result = await confirmAction("Proceed?");
    expect(result).toBe(true);
  });

  it("returns the confirm answer (false)", async () => {
    answerQueue = [false];
    const result = await confirmAction("Proceed?");
    expect(result).toBe(false);
  });

  it("cancel -> p.cancel + returns false", async () => {
    answerQueue = [CANCEL];
    const result = await confirmAction("Proceed?");
    expect(result).toBe(false);
    expect(p.cancel).toHaveBeenCalledWith("Operation cancelled.");
  });
});

describe("command-factory: cancelOperation", () => {
  it("emits p.cancel(message) and process.exit(0)", () => {
    const origExit = process.exit;
    process.exit = ((code?: number): never => {
      throw new ProcessExitError(code ?? 0);
    }) as typeof process.exit;

    let exitCode: number | null = null;
    try {
      cancelOperation("bye now");
    } catch (err) {
      if (err instanceof ProcessExitError) {
        exitCode = err.code;
      } else {
        throw err;
      }
    } finally {
      process.exit = origExit;
    }

    expect(p.cancel).toHaveBeenCalledWith("bye now");
    expect(exitCode).toBe(0);
  });

  it("defaults the message to 'Operation cancelled.'", () => {
    const origExit = process.exit;
    process.exit = ((code?: number): never => {
      throw new ProcessExitError(code ?? 0);
    }) as typeof process.exit;

    try {
      cancelOperation();
    } catch (err) {
      if (!(err instanceof ProcessExitError)) {
        throw err;
      }
    } finally {
      process.exit = origExit;
    }

    expect(p.cancel).toHaveBeenCalledWith("Operation cancelled.");
  });
});
