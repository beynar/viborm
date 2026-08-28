/**
 * INTEGRATION tests for `viborm push` against the V1 history-free CLI.
 *
 * Preview is inert. Effectful apply uses the consent from that preview.
 * There is no `--force`, `--strict`, or journal/storage friend seam.
 * `--force-reset --dry-run` must perform zero database effects.
 *
 * File-backed PGlite is required so disconnect does not destroy the database.
 */

import { join } from "node:path";
import { isSha256 } from "@src/migrations/identity";
import {
  CANCEL,
  invokeCLI,
  makeTempProject,
  queueAnswers,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CREATE_TABLE = /CREATE TABLE/i;
const UNKNOWN_OPTION_FORCE = /unknown option|force/;
const UNKNOWN_OPTION_STRICT = /unknown option|strict/;

const PUSH_OPTION_DEFAULTS = {
  forceReset: false,
  yes: false,
  json: false,
  dryRun: false,
} as const;

async function resetPushOptions(): Promise<void> {
  const { pushCommand } = await import("@src/cli/commands/push");
  (
    pushCommand as unknown as { _optionValues: Record<string, unknown> }
  )._optionValues = { ...PUSH_OPTION_DEFAULTS };
}

function dataDir(project: TempProject): string {
  return join(project.dir, "pgdata");
}

const DEFAULT_MODEL = `
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
  });
  const schema = { user };
`;

const NO_UNIQUE_MODEL = `
  const user = s.model({
    id: s.string().id(),
    email: s.string(),
  });
  const schema = { user };
`;

function writePersistentConfig(
  project: TempProject,
  schemaBody: string = DEFAULT_MODEL
): void {
  writeConfigFixture(project, { dataDir: dataDir(project), schemaBody });
}

async function withDb<T>(
  project: TempProject,
  fn: (query: (sql: string) => Promise<{ rows: unknown[] }>) => Promise<T>
): Promise<T> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create(dataDir(project));
  try {
    return await fn((sql) => db.query(sql));
  } finally {
    await db.close();
  }
}

function tableExists(
  project: TempProject,
  tableName: string
): Promise<boolean> {
  return withDb(project, async (query) => {
    const res = await query(`SELECT to_regclass('public.${tableName}') AS reg`);
    return (res.rows[0] as { reg: unknown } | undefined)?.reg != null;
  });
}

function columnsOf(project: TempProject, tableName: string): Promise<string[]> {
  return withDb(project, async (query) => {
    const res = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`
    );
    return res.rows.map((row) => (row as { column_name: string }).column_name);
  });
}

function execOnDb(project: TempProject, sql: string): Promise<void> {
  return withDb(project, async (query) => {
    await query(sql);
  });
}

function readJson(result: { stdout: string; output: string }): unknown {
  const text = result.stdout.trim() || result.output.trim();
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error(`Expected JSON in CLI output:\n${text}`);
  }
  return JSON.parse(text.slice(start));
}

describe("push command", () => {
  let project: TempProject;

  async function runPush(args: string[]) {
    await resetPushOptions();
    return invokeCLI(["push", ...args, "--config", project.configPath], {
      cwd: project.dir,
    });
  }

  beforeEach(async () => {
    project = makeTempProject();
    queueAnswers([]);
    await resetPushOptions();
  });

  afterEach(() => {
    project.cleanup();
  });

  it("applies a fresh schema with --yes: creates the table", async () => {
    writePersistentConfig(project);

    const result = await runPush(["--yes"]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Push applied.");
    expect(await tableExists(project, "user")).toBe(true);
    expect(await columnsOf(project, "user")).toEqual(
      expect.arrayContaining(["id", "email"])
    );
  });

  it("--dry-run previews SQL and applies nothing", async () => {
    writePersistentConfig(project);

    const result = await runPush(["--dry-run"]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Push plan");
    expect(result.output.toUpperCase()).toContain("CREATE TABLE");
    expect(result.output).not.toContain("Push applied.");
    expect(await tableExists(project, "user")).toBe(false);
  });

  it("--dry-run --json prints an inert preview", async () => {
    writePersistentConfig(project);

    const result = await runPush(["--dry-run", "--json"]);
    expect(result.thrown).toBeUndefined();
    const preview = readJson(result) as {
      outcome: string;
      planHash: string;
      statements: { sql: string }[];
      consent: { planHash: string };
    };
    expect(preview.outcome).toBe("planned");
    expect(isSha256(preview.planHash)).toBe(true);
    expect(preview.consent.planHash).toBe(preview.planHash);
    expect(
      preview.statements.some((statement) => CREATE_TABLE.test(statement.sql))
    ).toBe(true);
    expect(await tableExists(project, "user")).toBe(false);
  });

  it("re-push is a no-op", async () => {
    writePersistentConfig(project, NO_UNIQUE_MODEL);

    const first = await runPush(["--yes"]);
    expect(first.exitCode).toBeNull();
    expect(await tableExists(project, "user")).toBe(true);

    queueAnswers([]);
    const second = await runPush(["--yes"]);
    expect(second.thrown).toBeUndefined();
    expect(second.exitCode).toBeNull();
    expect(second.output).toContain("Schema is up to date.");
    expect(second.output).not.toContain("Push applied.");
    expect(await tableExists(project, "user")).toBe(true);
  });

  it("declining the apply confirm cancels: nothing applied", async () => {
    writePersistentConfig(project);
    queueAnswers([false]);

    const result = await runPush([]);

    expect(result.output).toContain("Push cancelled.");
    expect(result.output).not.toContain("Push applied.");
    expect(await tableExists(project, "user")).toBe(false);
  });

  it("cancelling (Ctrl-C) the apply confirm applies nothing", async () => {
    writePersistentConfig(project);
    queueAnswers([CANCEL]);

    const result = await runPush([]);

    expect(result.output).toContain("Push cancelled.");
    expect(result.output).not.toContain("Push applied.");
    expect(await tableExists(project, "user")).toBe(false);
  });

  it("--force-reset --dry-run performs zero writes", async () => {
    writePersistentConfig(project);
    await runPush(["--yes"]);
    await execOnDb(project, "CREATE TABLE stray (x int)");
    expect(await tableExists(project, "user")).toBe(true);
    expect(await tableExists(project, "stray")).toBe(true);

    const result = await runPush(["--force-reset", "--dry-run"]);
    expect(result.thrown).toBeUndefined();
    expect(result.output).toContain("Push plan");
    expect(result.output).not.toContain("Push applied.");
    expect(await tableExists(project, "user")).toBe(true);
    expect(await tableExists(project, "stray")).toBe(true);
  });

  it("--force-reset --yes drops unmanaged objects and rebuilds the schema", async () => {
    writePersistentConfig(project);
    await runPush(["--yes"]);
    await execOnDb(project, "CREATE TABLE stray (x int)");
    expect(await tableExists(project, "stray")).toBe(true);

    const result = await runPush(["--force-reset", "--yes"]);
    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Push applied.");
    expect(await tableExists(project, "stray")).toBe(false);
    expect(await tableExists(project, "user")).toBe(true);
  });

  it("--force-reset cancelled (NO): existing table kept", async () => {
    writePersistentConfig(project);
    await runPush(["--yes"]);
    expect(await tableExists(project, "user")).toBe(true);

    queueAnswers([false]);
    const result = await runPush(["--force-reset"]);
    expect(result.output).toContain("Push cancelled.");
    expect(await tableExists(project, "user")).toBe(true);
  });

  it("--force is not a V1 push option", async () => {
    writePersistentConfig(project);
    const result = await runPush(["--force"]);
    expect(result.thrown ?? result.exitCode).toBeTruthy();
    expect(result.output.toLowerCase()).toMatch(UNKNOWN_OPTION_FORCE);
    expect(await tableExists(project, "user")).toBe(false);
  });

  it("--strict is not a V1 push option", async () => {
    writePersistentConfig(project);
    const result = await runPush(["--strict"]);
    expect(result.thrown ?? result.exitCode).toBeTruthy();
    expect(result.output.toLowerCase()).toMatch(UNKNOWN_OPTION_STRICT);
  });

  it("a non-existent --config path errors and exits 1", async () => {
    const result = await invokeCLI(
      ["push", "--config", "/no/such/viborm.config.ts"],
      { cwd: project.dir }
    );
    expect(result.exitCode ?? 1).not.toBe(0);
    expect(result.output).toContain("Could not find VibORM configuration file");
  });

  it("a config whose client is missing errors", async () => {
    writeConfigFixture(project, {
      rawConfigSource: "export default { client: undefined };\n",
    });
    const result = await invokeCLI(["push", "--config", project.configPath], {
      cwd: project.dir,
    });
    expect(result.exitCode ?? 1).not.toBe(0);
    expect(result.output).toContain('Missing "client"');
  });

  it("a schema with a model lacking an id field fails validation", async () => {
    writeConfigFixture(project, {
      schemaBody: `
        const user = s.model({
          email: s.string(),
        });
        const schema = { user };
      `,
    });
    const result = await invokeCLI(["push", "--config", project.configPath], {
      cwd: project.dir,
    });
    expect(result.exitCode ?? 1).not.toBe(0);
    expect(result.output.toLowerCase()).toContain("validation");
    expect(await tableExists(project, "user")).toBe(false);
  });
});
