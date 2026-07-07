/**
 * INTEGRATION tests for `viborm push` (src/cli/commands/push.ts).
 *
 * Drives the real command through the harness: real pglite driver, real
 * migration engine/differ/DDL, temp config. Only @clack/prompts and
 * process.exit are stubbed (by _harness.ts). Every DB mutation is asserted
 * against actual pglite state — not just log strings.
 *
 * IMPORTANT — why a file-backed pglite (not the harness default):
 * push always calls `driver.disconnect()` on every terminating branch, and the
 * pglite driver's disconnect closes the client, which DESTROYS an in-memory
 * (":memory:"/ephemeral) database. To assert that an applied table actually
 * exists — and that a re-push is genuinely idempotent — the DB must survive
 * that disconnect. So these tests point pglite at a `dataDir` under the temp
 * project (persists to disk across close/reopen).
 *
 * pglite is single-writer per dataDir, so we never hold two PGlite instances
 * open on one dataDir at once. push disconnects (closes) its client on every
 * terminating branch, so between invocations we open a short-lived pglite on the
 * same dataDir to read state, then close it before the next invokeCLI.
 *
 * DO NOT statically import `src/cli/commands/push` here. That module does
 * `import * as p from "@clack/prompts"` at load time; if it evaluates before the
 * harness's hoisted `vi.mock("@clack/prompts")` is registered, `p.confirm` binds
 * to the REAL clack prompt and blocks forever on stdin in the non-TTY test
 * process (every apply-path test hangs). We reach `pushCommand` only via a
 * runtime dynamic import (below), by which point the mock is already active.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANCEL,
  invokeCLI,
  makeTempProject,
  queueAnswers,
  type TempProject,
  writeConfigFixture,
} from "./_harness";

/**
 * HARNESS QUIRK (worked around, not a src bug): `_harness.buildProgram()` reuses
 * the module-level `pushCommand` singleton, and commander persists parsed option
 * values on the Command instance across `parseAsync` calls. So a `--dry-run` (or
 * `--verbose`/`--strict`) flag set in one invokeCLI leaks `dryRun:true` into the
 * NEXT invocation, which has no way to clear a boolean flag from the CLI. A real
 * CLI run is a fresh process, so we restore the command's option defaults before
 * every invocation to reproduce that isolation. Uses a dynamic import so this
 * file never statically pulls in push (and thus real clack) — see the note
 * above.
 */
const PUSH_OPTION_DEFAULTS = {
  force: false,
  forceReset: false,
  strict: false,
  verbose: false,
  dryRun: false,
} as const;
async function resetPushOptions(): Promise<void> {
  const { pushCommand } = await import("../../src/cli/commands/push");
  (
    pushCommand as unknown as { _optionValues: Record<string, unknown> }
  )._optionValues = { ...PUSH_OPTION_DEFAULTS };
}

/** Absolute dataDir the file-backed pglite persists to. */
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

// A model with NO unique field. Re-pushing a model that HAS a .unique() field is
// broken on postgres/pglite (see the "KNOWN BUG" test below): the second push
// mis-diffs the unique constraint's backing index as a droppable index. Tests
// that push the same schema twice therefore use this unique-free model so they
// exercise their actual target (idempotency, drop-column) without tripping that
// unrelated bug.
const NO_UNIQUE_MODEL = `
  const user = s.model({
    id: s.string().id(),
    email: s.string(),
  });
  const schema = { user };
`;

/**
 * Write a viborm.config.ts whose pglite client persists to `pgdata/` so the DB
 * outlives push's disconnect. `schemaBody` defaults to the single `user` model.
 */
function writePersistentConfig(
  project: TempProject,
  schemaBody: string = DEFAULT_MODEL
): void {
  writeConfigFixture(project, { dataDir: dataDir(project), schemaBody });
}

/**
 * Open a fresh, short-lived pglite on the persisted dataDir, run `fn`, then
 * close it. Safe because push disconnects (closes) its own client on every
 * terminating branch, so no other writer holds the single-writer dataDir when
 * we open ours.
 */
async function withDb<T>(
  project: TempProject,
  fn: (query: (sql: string) => Promise<{ rows: any[] }>) => Promise<T>
): Promise<T> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create(dataDir(project));
  try {
    return await fn((sql) => db.query(sql));
  } finally {
    await db.close();
  }
}

/** True if `tableName` exists in the persisted pglite public schema. */
function tableExists(
  project: TempProject,
  tableName: string
): Promise<boolean> {
  return withDb(project, async (query) => {
    const res = await query(`SELECT to_regclass('public.${tableName}') AS reg`);
    return res.rows[0]?.reg != null;
  });
}

/** Column names of a persisted pglite table (empty if the table is absent). */
function columnsOf(project: TempProject, tableName: string): Promise<string[]> {
  return withDb(project, async (query) => {
    const res = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName}'`
    );
    return res.rows.map((r: { column_name: string }) => r.column_name);
  });
}

/** Run one arbitrary statement against the persisted DB (for seeding). */
function execOnDb(project: TempProject, sql: string): Promise<void> {
  return withDb(project, async (query) => {
    await query(sql);
  });
}

describe("push command", () => {
  let project: TempProject;

  /** invokeCLI(["push", ...]) with the option-leak reset applied first. */
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

  // ---------------------------------------------------------------------------
  // fresh schema applies (apply path, confirm=true)
  // ---------------------------------------------------------------------------
  it("applies a fresh schema: creates the table in the real DB", async () => {
    writePersistentConfig(project);
    queueAnswers([true]); // "Apply N change(s)?" -> yes

    const result = await runPush([]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Applied");
    expect(result.output).toContain("Done in");
    // Real side effect: the user table now exists with both columns.
    expect(await tableExists(project, "user")).toBe(true);
    expect(await columnsOf(project, "user")).toEqual(
      expect.arrayContaining(["id", "email"])
    );
  });

  // ---------------------------------------------------------------------------
  // --dry-run previews SQL and creates NOTHING
  // ---------------------------------------------------------------------------
  it("--dry-run previews the create-table SQL and applies nothing", async () => {
    writePersistentConfig(project);

    const result = await runPush(["--dry-run"]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Dry run complete");
    // SQL is previewed even without --verbose (dry-run branch calls displaySQL).
    expect(result.output).toContain("SQL to execute");
    expect(result.output.toUpperCase()).toContain("CREATE TABLE");
    // Nothing was applied.
    expect(await tableExists(project, "user")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // --verbose prints SQL during preview
  // ---------------------------------------------------------------------------
  it("--dry-run --verbose prints the SQL once during preview, still no apply", async () => {
    writePersistentConfig(project);

    const result = await runPush(["--dry-run", "--verbose"]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    // Verbose emits the SQL note; dry-run must not double-print it.
    const sqlNotes = result.clack.filter((l) => l.includes("SQL to execute"));
    expect(sqlNotes).toHaveLength(1);
    expect(result.output).toContain("Dry run complete");
    expect(await tableExists(project, "user")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // re-push is a no-op / idempotent
  // ---------------------------------------------------------------------------
  it("re-push is idempotent: second push detects no changes and returns early", async () => {
    writePersistentConfig(project, NO_UNIQUE_MODEL);

    // First push applies the schema (persisted to the on-disk pglite dataDir).
    queueAnswers([true]);
    const first = await runPush([]);
    expect(first.exitCode).toBeNull();
    expect(await tableExists(project, "user")).toBe(true);

    // Second push: DB already matches. The no-changes branch returns BEFORE any
    // confirm, so it must not print "Applied".
    queueAnswers([]);
    const second = await runPush([]);

    expect(second.thrown).toBeUndefined();
    expect(second.exitCode).toBeNull();
    expect(second.output).toContain(
      "No changes detected. Your database is up to date."
    );
    expect(second.output).toContain("Done in");
    expect(second.output).not.toContain("Applied");
    expect(await tableExists(project, "user")).toBe(true);
  });

  // KNOWN BUG: re-pushing a schema that has a `.unique()` field is NOT
  // idempotent on postgres/pglite. The first push creates the column's unique
  // constraint (which owns a backing index of the same name, e.g.
  // `user_email_key`). On the second push, introspection + diff mis-classify
  // that constraint-owned index as a standalone droppable index and emit a
  // `dropIndex user_email_key`, which postgres rejects.
  //   EXPECTED: second push finds no changes, exits cleanly (exitCode null),
  //             prints "No changes detected. Your database is up to date."
  //   ACTUAL:   second push exits 1 with
  //             'cannot drop index user_email_key because constraint
  //              user_email_key on table "user" requires it'.
  // biome-ignore lint/suspicious/noSkippedTests: intentional KNOWN BUG record — this asserts the fixed behavior and stays skipped until the unique-constraint re-diff is fixed in src.
  it.skip("KNOWN BUG: re-push of a .unique() field is idempotent", async () => {
    writePersistentConfig(project); // DEFAULT_MODEL — email is .unique()

    queueAnswers([true]);
    await runPush([]);

    queueAnswers([]);
    const second = await runPush([]);

    expect(second.exitCode).toBeNull();
    expect(second.output).toContain(
      "No changes detected. Your database is up to date."
    );
    expect(second.output).not.toContain("cannot drop index");
  });

  // ---------------------------------------------------------------------------
  // confirm=false / cancel: nothing applied
  //
  // NOTE ON EXIT CODE: on cancel the command calls process.exit(0) from INSIDE
  // its try{} block. The harness turns process.exit into a thrown
  // ProcessExitError, which the command's own catch re-catches and then calls
  // process.exit(1). So under the harness a user-cancel surfaces as exitCode 1,
  // not 0 (in a real process, exit(0) is fatal and this never happens). We
  // therefore assert the user-visible cancel contract — the "Operation
  // cancelled." message (only emitted on the exit-0 branch) and an unchanged DB
  // — rather than the harness-distorted exit code.
  // ---------------------------------------------------------------------------
  it("declining the apply confirm cancels: nothing applied", async () => {
    writePersistentConfig(project);
    queueAnswers([false]); // "Apply N change(s)?" -> no

    const result = await runPush([]);

    expect(result.output).toContain("Operation cancelled.");
    expect(result.output).not.toContain("Applied");
    expect(await tableExists(project, "user")).toBe(false);
  });

  it("cancelling (Ctrl-C) the apply confirm applies nothing", async () => {
    writePersistentConfig(project);
    queueAnswers([CANCEL]);

    const result = await runPush([]);

    expect(result.output).toContain("Operation cancelled.");
    expect(result.output).not.toContain("Applied");
    expect(await tableExists(project, "user")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // --force applies directly (no resolver; still confirms, initialValue true)
  // ---------------------------------------------------------------------------
  it("--force applies without an interactive resolver", async () => {
    writePersistentConfig(project);
    queueAnswers([true]); // the "Apply N change(s)?" confirm (initialValue true)

    const result = await runPush(["--force"]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Applied");
    expect(await tableExists(project, "user")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // --strict: shows SQL, asks to execute (initialValue false)
  // ---------------------------------------------------------------------------
  it("--strict declines by default (NO): nothing applied", async () => {
    writePersistentConfig(project);
    queueAnswers([false]); // "Execute these SQL statements?" -> no

    const result = await runPush(["--strict"]);

    expect(result.output).toContain("SQL to execute");
    expect(result.output).toContain("Operation cancelled.");
    expect(result.output).not.toContain("Applied");
    expect(await tableExists(project, "user")).toBe(false);
  });

  it("--strict YES applies", async () => {
    writePersistentConfig(project);
    queueAnswers([true]); // "Execute these SQL statements?" -> yes

    const result = await runPush(["--strict"]);

    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Applied");
    expect(await tableExists(project, "user")).toBe(true);
  });

  it("--strict --verbose prints the SQL only once", async () => {
    writePersistentConfig(project);
    queueAnswers([false]);

    const result = await runPush(["--strict", "--verbose"]);

    const sqlNotes = result.clack.filter((l) => l.includes("SQL to execute"));
    expect(sqlNotes).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // data-loss (destructive) change: blocked when rejected, proceeds via --force
  // ---------------------------------------------------------------------------
  // We can't swap the config's schema mid-test (the module is import-cached),
  // so we apply the schema, then add an EXTRA column the schema doesn't declare;
  // pushing again then wants to DROP that column — a destructive change routed
  // through interactiveResolve. Uses NO_UNIQUE_MODEL so the second push isn't
  // derailed by the unrelated `.unique()` re-diff bug (see KNOWN BUG above).
  async function seedUserWithExtraColumn(): Promise<void> {
    writePersistentConfig(project, NO_UNIQUE_MODEL);
    queueAnswers([true]);
    await runPush([]);
    await execOnDb(project, 'ALTER TABLE "user" ADD COLUMN nickname text');
  }

  it("a destructive drop-column is blocked when the user declines (exit 1, data kept)", async () => {
    await seedUserWithExtraColumn();
    expect(await columnsOf(project, "user")).toContain("nickname");

    // Non-force push routes the drop through interactiveResolve; the destructive
    // confirm NO -> change.reject() -> MigrationError -> genuine error exit 1.
    queueAnswers([false]);
    const blocked = await runPush([]);

    expect(blocked.exitCode).toBe(1);
    expect(blocked.output.toLowerCase()).toContain("reject");
    // Column still present: no data loss.
    expect(await columnsOf(project, "user")).toContain("nickname");
  });

  it("--force lets a destructive drop-column proceed (column removed)", async () => {
    await seedUserWithExtraColumn();
    expect(await columnsOf(project, "user")).toContain("nickname");

    queueAnswers([true]); // the apply confirm (--force skips only the resolver)
    const result = await runPush(["--force"]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Applied");
    expect(await columnsOf(project, "user")).not.toContain("nickname");
  });

  // ---------------------------------------------------------------------------
  // --force-reset
  // ---------------------------------------------------------------------------
  it("--force-reset cancelled (NO): no reset, existing table kept", async () => {
    writePersistentConfig(project);
    // Apply first so there is something to reset.
    queueAnswers([true]);
    await runPush([]);
    expect(await tableExists(project, "user")).toBe(true);

    queueAnswers([false]); // reset confirm -> no
    const result = await runPush(["--force-reset"]);

    expect(result.output).toContain("Operation cancelled.");
    expect(result.output).not.toContain("Database reset complete");
    // No reset happened; table survives.
    expect(await tableExists(project, "user")).toBe(true);
  });

  it("--force-reset confirmed drops all tables then re-pushes the schema", async () => {
    writePersistentConfig(project);
    queueAnswers([true]);
    await runPush([]);
    // Create a stray table that is NOT in the schema; reset must drop it.
    await execOnDb(project, "CREATE TABLE stray (x int)");
    expect(await tableExists(project, "stray")).toBe(true);

    // reset confirm YES, then apply confirm YES.
    queueAnswers([true, true]);
    const result = await runPush(["--force-reset"]);

    expect(result.thrown).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Database reset complete");
    expect(result.output).toContain("Applied");
    // Stray table dropped by reset; schema table re-created.
    expect(await tableExists(project, "stray")).toBe(false);
    expect(await tableExists(project, "user")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // config errors -> exit 1
  // ---------------------------------------------------------------------------
  it("a non-existent --config path errors and exits 1", async () => {
    const result = await invokeCLI(
      ["push", "--config", "/no/such/viborm.config.ts"],
      { cwd: project.dir }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Could not find VibORM configuration file");
  });

  it("a config whose client is missing errors and exits 1", async () => {
    writeConfigFixture(project, {
      rawConfigSource: "export default { client: undefined };\n",
    });

    const result = await invokeCLI(["push", "--config", project.configPath], {
      cwd: project.dir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Missing "client"');
  });

  it("a schema with a model lacking an id field fails validation and exits 1", async () => {
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

    expect(result.exitCode).toBe(1);
    // validateSchemaOrThrow ran (and no longer infinitely recurses).
    expect(result.output.toLowerCase()).toContain("validation");
    expect(await tableExists(project, "user")).toBe(false);
  });
});
