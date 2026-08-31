import {
  CANCEL,
  getClackLog,
  queueAnswers,
  resetClackLog,
} from "@tests/contracts/public-client/cli/_clack";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PLAN_HASH = "a".repeat(64);
const TARGET = {
  dialect: "sqlite",
  location: null,
  bindingId: "test-binding",
} as const;
const CONSENT = {
  format: "viborm-migration-v1",
  target: TARGET,
  planHash: PLAN_HASH,
  mode: "diff",
  validation: "full",
  resolutions: [],
} as const;
const PLANNED = {
  outcome: "planned",
  target: TARGET,
  planHash: PLAN_HASH,
  schemaHash: PLAN_HASH,
  fingerprint: PLAN_HASH,
  destructive: false,
  operations: [{ id: "create:user", label: "Create user", risk: "safe" }],
  statements: [
    {
      sql: 'CREATE TABLE "user" ("id" text DEFAULT ?)',
      parameters: [{ kind: "string", value: "generated" }],
    },
  ],
  consent: CONSENT,
} as const;
const APPLIED = {
  outcome: "applied",
  target: TARGET,
  planHash: PLAN_HASH,
  operations: PLANNED.operations,
  statements: PLANNED.statements,
} as const;

const boundary = vi.hoisted(() => {
  const disconnect = vi.fn();
  return {
    client: { $disconnect: disconnect },
    createMigrationClient: vi.fn(),
    disconnect,
    failCli: vi.fn((error: unknown): never => {
      throw error;
    }),
    loadConfig: vi.fn(),
    push: vi.fn(),
  };
});

vi.mock("@src/cli/utils", () => ({
  failCli: boundary.failCli,
  loadConfig: boundary.loadConfig,
}));

vi.mock("@src/migrations/client", () => ({
  createMigrationClient: boundary.createMigrationClient,
}));

import { createPushCommand } from "@src/cli/commands/push";

interface Invocation {
  readonly output: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly thrown: unknown;
}

async function invoke(args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  resetClackLog();
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
  const program = new Command();
  program.exitOverride();
  program.addCommand(createPushCommand());
  let thrown: unknown;

  try {
    await program.parseAsync(["node", "viborm", "push", ...args]);
  } catch (error) {
    thrown = error;
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const stdoutText = stdout.join("");
  const stderrText = stderr.join("");
  return {
    output: [...stdout, ...stderr, ...getClackLog()].join("\n"),
    stderr: stderrText,
    stdout: stdoutText,
    thrown,
  };
}

function route(preview: unknown = PLANNED, applied: unknown = APPLIED): void {
  boundary.push.mockResolvedValueOnce(preview).mockResolvedValueOnce(applied);
}

describe("push command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.push.mockReset();
    queueAnswers([]);
    boundary.loadConfig.mockResolvedValue({ client: boundary.client });
    boundary.createMigrationClient.mockReturnValue({ push: boundary.push });
    route();
  });

  it("publishes the exact option vocabulary", () => {
    const command = createPushCommand();
    expect(command.options.map(({ long }) => long)).toEqual([
      "--config",
      "--dry-run",
      "--force-reset",
      "--yes",
      "--json",
    ]);
  });

  it("prints an inert human-readable preview without requesting consent", async () => {
    const result = await invoke(["--dry-run", "--config", "custom.ts"]);

    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain("Push plan");
    expect(result.output).toContain(`Plan: ${PLAN_HASH}`);
    expect(result.output).toContain("[safe] Create user (create:user)");
    expect(result.output).toContain(
      '1. CREATE TABLE "user" ("id" text DEFAULT ?)'
    );
    expect(result.output).toContain(
      'parameters: [{"kind":"string","value":"generated"}]'
    );
    expect(boundary.loadConfig).toHaveBeenCalledWith({ config: "custom.ts" });
    expect(boundary.push).toHaveBeenCalledOnce();
    expect(boundary.push).toHaveBeenCalledWith({ dryRun: true });
    expect(boundary.disconnect).toHaveBeenCalledOnce();
  });

  it("prints unparameterized SQL without an empty parameter annotation", async () => {
    boundary.push.mockReset();
    boundary.push.mockResolvedValueOnce({
      ...PLANNED,
      statements: [{ sql: 'CREATE TABLE "user" ("id" text)', parameters: [] }],
    });

    const result = await invoke(["--dry-run"]);

    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain('1. CREATE TABLE "user" ("id" text)');
    expect(result.output).not.toContain("parameters:");
    expect(boundary.push).toHaveBeenCalledOnce();
  });

  it("prints the exact inert preview as JSON", async () => {
    const result = await invoke(["--dry-run", "--json"]);

    expect(result.thrown).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual(PLANNED);
    expect(result.output).not.toContain("Push plan");
    expect(boundary.push).toHaveBeenCalledOnce();
  });

  it("applies only the consent from the preview when --yes is present", async () => {
    const result = await invoke(["--yes"]);

    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain("Push plan");
    expect(result.output).toContain("Push applied.");
    expect(boundary.push.mock.calls).toEqual([
      [{ dryRun: true }],
      [{ consent: CONSENT }],
    ]);
    expect(boundary.disconnect).toHaveBeenCalledOnce();
  });

  it("applies with JSON output without printing the human plan", async () => {
    const result = await invoke(["--yes", "--json"]);

    expect(result.thrown).toBeUndefined();
    expect(JSON.parse(result.stdout)).toEqual(APPLIED);
    expect(result.output).not.toContain("Push plan");
    expect(result.output).not.toContain("Push applied.");
  });

  it("requires --yes for a non-interactive JSON apply", async () => {
    const result = await invoke(["--json"]);

    expect(result.thrown).toEqual(
      new Error("Non-interactive push requires --yes to apply a plan")
    );
    expect(boundary.failCli).toHaveBeenCalledOnce();
    expect(boundary.push).toHaveBeenCalledOnce();
    expect(boundary.disconnect).toHaveBeenCalledOnce();
  });

  it("uses the preview defaults for ordinary interactive acceptance", async () => {
    const result = await invoke([]);

    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain("Push applied.");
    expect(boundary.push).toHaveBeenCalledTimes(2);
  });

  it("defaults destructive interactive plans to refusal", async () => {
    boundary.push.mockReset();
    route({ ...PLANNED, destructive: true });

    const result = await invoke([]);

    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain("Push cancelled.");
    expect(boundary.push).toHaveBeenCalledOnce();
  });

  it("applies a destructive plan after explicit interactive acceptance", async () => {
    boundary.push.mockReset();
    route({ ...PLANNED, destructive: true });
    queueAnswers([true]);

    const result = await invoke([]);

    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain("Push applied.");
    expect(boundary.push).toHaveBeenCalledTimes(2);
  });

  it("treats explicit refusal and Ctrl-C as cancellation without applying", async () => {
    queueAnswers([false]);
    const refused = await invoke([]);
    expect(refused.output).toContain("Push cancelled.");
    expect(boundary.push).toHaveBeenCalledOnce();

    boundary.push.mockReset();
    route();
    queueAnswers([CANCEL]);
    const cancelled = await invoke([]);
    expect(cancelled.output).toContain("Push cancelled.");
    expect(boundary.push).toHaveBeenCalledOnce();
  });

  it("confines force-reset to inert planning and applies only consent", async () => {
    const forceConsent = { ...CONSENT, mode: "force-reset" } as const;
    boundary.push.mockReset();
    route({ ...PLANNED, consent: forceConsent });

    const result = await invoke(["--force-reset", "--yes"]);

    expect(result.thrown).toBeUndefined();
    expect(boundary.push.mock.calls).toEqual([
      [{ dryRun: true, forceReset: true }],
      [{ consent: forceConsent }],
    ]);
  });

  it("reports a no-op without asking for consent", async () => {
    const noopPreview = {
      ...PLANNED,
      outcome: "noop",
      operations: [],
      statements: [],
    } as const;
    boundary.push.mockReset();
    route(noopPreview, { ...APPLIED, outcome: "noop" });

    const result = await invoke([]);

    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain("Schema is up to date.");
    expect(result.output).not.toContain("Push applied.");
    expect(boundary.push).toHaveBeenCalledTimes(2);
  });

  it("translates config and migration failures and disconnects only acquired clients", async () => {
    const configFailure = new Error("config unavailable");
    boundary.loadConfig.mockRejectedValueOnce(configFailure);
    const missing = await invoke([]);
    expect(missing.thrown).toBe(configFailure);
    expect(boundary.failCli).toHaveBeenCalledWith(configFailure);
    expect(boundary.disconnect).not.toHaveBeenCalled();

    vi.clearAllMocks();
    boundary.push.mockReset();
    boundary.loadConfig.mockResolvedValue({ client: boundary.client });
    boundary.createMigrationClient.mockReturnValue({ push: boundary.push });
    const previewFailure = new Error("preview unavailable");
    boundary.push.mockRejectedValueOnce(previewFailure);
    const failedPreview = await invoke([]);
    expect(failedPreview.thrown).toBe(previewFailure);
    expect(boundary.failCli).toHaveBeenCalledWith(previewFailure);
    expect(boundary.disconnect).toHaveBeenCalledOnce();
  });

  it("refuses retired --force and --strict options before loading config", async () => {
    for (const option of ["--force", "--strict"]) {
      const result = await invoke([option]);
      expect(result.thrown).toBeDefined();
      expect(result.output).toContain(`unknown option '${option}'`);
    }
    expect(boundary.loadConfig).not.toHaveBeenCalled();
  });
});

describe("coverage low value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.push.mockReset();
    queueAnswers([]);
    boundary.loadConfig.mockResolvedValue({ client: boundary.client });
    boundary.createMigrationClient.mockReturnValue({ push: boundary.push });
  });

  it("prints the explicit empty-plan sentence and omits an empty SQL section", async () => {
    boundary.push.mockResolvedValueOnce({
      ...PLANNED,
      outcome: "noop",
      operations: [],
      statements: [],
    });

    const result = await invoke(["--dry-run"]);

    expect(result.output).toContain("No schema changes.");
    expect(result.output).not.toContain("SQL:");
  });
});
