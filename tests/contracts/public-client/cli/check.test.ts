import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCheckCommand } from "@src/cli/commands/check";
import { createClient } from "@src/drivers/sqlite3";
import { s } from "@src/schema";
import {
  makeTempProject,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const DUPLICATE_TABLES = `
  const user = s.model({ id: s.string().id() }).map("people");
  const member = s.model({ id: s.string().id() }).map("people");
  const schema = { user, member };
`;

const UNUSED_FOREIGN_KEY = `
  const user = s.model({ id: s.string().id(), teamId: s.string() }).map("users");
  const schema = { user };
`;

let project: TempProject | undefined;
afterEach(() => {
  project?.cleanup();
  project = undefined;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function check(
  schemaBody?: string,
  driverOptions = "",
  args: string[] = []
) {
  project = makeTempProject();
  writeConfigFixture(project, {
    dialect: "sqlite3",
    ...(schemaBody ? { schemaBody } : {}),
  });
  if (driverOptions) {
    // The application creates its client without the runtime checks.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const source = readFileSync(project.configPath, "utf8");
    writeFileSync(
      project.configPath,
      source.replace(
        'dataDir: ":memory:" }',
        `dataDir: ":memory:", ${driverOptions} }`
      )
    );
  }
  return run(project.configPath, args);
}

/** A sqlite3 config on a file database the test also opens directly. */
function fileDatabase(schemaBody: string) {
  project = makeTempProject();
  const file = join(project.dir, "app.db");
  writeConfigFixture(project, {
    dialect: "sqlite3",
    schemaBody,
    dataDir: file,
  });
  return { configPath: project.configPath, db: new Database(file) };
}

async function run(configPath: string, args: string[]) {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  await createCheckCommand().parseAsync(["--config", configPath, ...args], {
    from: "user",
  });
  vi.restoreAllMocks();
  return out.join("");
}

const PRICED = `
  const item = s.model({
    id: s.int().id(),
    price: s.decimal({ precision: 10, scale: 2 }),
    prices: s.decimal({ precision: 10, scale: 2 }).array(),
  }).map("item");
  const schema = { item };
`;

const TEMPORAL = `
  import { TYPES } from ${JSON.stringify(pathToFileURL(join(SOURCE_ROOT, "schema/index.ts")).href)};
  const event = s.model({
    id: s.int().id(),
    title: s.string(),
    at: s.dateTime(),
    clock: s.time(),
    moments: s.dateTime().array(),
    stamp: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER),
  }).map("event");
  const schema = { event };
`;

describe("viborm check", () => {
  it("accepts a valid schema", async () => {
    expect(await check()).toContain("Schema valid (1 models).");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports what a client created with skipSchemaValidation did not check", async () => {
    const output = await check(DUPLICATE_TABLES, "skipSchemaValidation: true");
    expect(output).toContain("[M004]");
    expect(output).toContain("Schema invalid");
    expect(process.exitCode).toBe(1);
  });

  it("prints advisory warnings without failing", async () => {
    const output = await check(UNUSED_FOREIGN_KEY);
    expect(output).toContain("warning [CM001]");
    expect(output).toContain("Schema valid (1 models).");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints the result as JSON with --json", async () => {
    const result = JSON.parse(await check(undefined, "", ["--json"]));
    expect(result).toMatchObject({ valid: true, errors: [] });
  });

  it("fails the command when the config cannot be loaded", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(
      createCheckCommand().parseAsync(
        ["--config", "/nonexistent/viborm.config.ts"],
        { from: "user" }
      )
    ).rejects.toThrow("exit 1");
  });

  it("--db counts noncanonical SQLite DateTime/Time text per column and prints the repair", async () => {
    const { configPath, db } = fileDatabase(TEMPORAL);
    db.exec(`CREATE TABLE event (id INTEGER PRIMARY KEY, title TEXT, at TEXT, clock TEXT, moments TEXT, stamp INTEGER);
      INSERT INTO event VALUES (1, 'canonical', '2024-01-15T10:30:00.000Z', '12:30:00.000', '["2024-01-15T10:30:00.000Z"]', 0);
      INSERT INTO event VALUES (2, 'rc.x', '2024-01-15T10:30:00Z', '12:30:00', '["2024-01-15 10:30:00"]', 0);`);
    try {
      const output = await run(configPath, ["--db"]);
      expect(output).toContain(
        '[storage] "event"."at": 1 row(s) of noncanonical DateTime text compare and sort wrongly.\n    Repair with sqliteCanonicalDateTimeExpression'
      );
      expect(output).toContain("Repair with sqliteCanonicalTimeExpression");
      // The scalar expression aborts on a JSON array; a list goes through `update`.
      expect(output).toContain(
        '"event"."moments": 1 row(s) of noncanonical DateTime text compare and sort wrongly.\n    Rewrite each row through the typed client (`update`)'
      );
      expect(output).toContain("Storage audited: 3 column(s), 3 need repair.");
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      db.exec(
        `UPDATE event SET at = '2024-01-15T10:30:00.000Z', clock = '12:30:00.000', moments = '["2024-01-15T10:30:00.000Z"]'`
      );
      const result = JSON.parse(await run(configPath, ["--db", "--json"]));
      expect(result).toMatchObject({ valid: true, errors: [] });
      expect(result.storage).toEqual(
        [
          ["at", "datetime", false],
          ["clock", "time", false],
          ["moments", "datetime", true],
        ].map(([column, type, list]) => ({
          table: "event",
          column,
          type,
          list,
          noncanonical: 0,
        }))
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("--db reports a missing column or table from the catalog instead of scanning it", async () => {
    const { configPath, db } = fileDatabase(TEMPORAL);
    const missing = (column: string) =>
      `[storage] "event"."${column}": the column is missing; typed queries that use it fail.\n    Create it through viborm push or migrate.`;
    try {
      // An empty table without `at`: a scan would count zero rows.
      db.exec(
        "CREATE TABLE event (id INTEGER PRIMARY KEY, title TEXT, clock TEXT, moments TEXT, stamp INTEGER)"
      );
      const empty = await run(configPath, ["--db"]);
      expect(empty).toContain(missing("at"));
      expect(empty).toContain("Storage audited: 3 column(s), 1 need repair.");
      expect(process.exitCode).toBe(1);

      // Rows without `clock` are not reported as noncanonical Time text.
      process.exitCode = undefined;
      db.exec(`DROP TABLE event;
        CREATE TABLE event (id INTEGER PRIMARY KEY, title TEXT, at TEXT, moments TEXT, stamp INTEGER);
        INSERT INTO event VALUES (1, 'a', '2024-01-15T10:30:00.000Z', '[]', 0), (2, 'b', '2024-01-15T10:30:00.000Z', '[]', 0);`);
      const result = JSON.parse(await run(configPath, ["--db", "--json"]));
      expect(result.storage).toEqual(
        [
          ["at", "datetime", false, 0],
          ["clock", "time", false, null],
          ["moments", "datetime", true, 0],
        ].map(([column, type, list, noncanonical]) => ({
          table: "event",
          column,
          type,
          list,
          noncanonical,
        }))
      );
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      db.exec("DROP TABLE event");
      const absent = await run(configPath, ["--db"]);
      for (const column of ["at", "clock", "moments"])
        expect(absent).toContain(missing(column));
      expect(absent).toContain("Storage audited: 3 column(s), 3 need repair.");
      expect(process.exitCode).toBe(1);
    } finally {
      db.close();
    }
  });

  it("--db reports SQLite decimal columns that are not VibORM's checked storage", async () => {
    const { configPath, db } = fileDatabase(PRICED);
    // Another tool's table: typed queries never inspect it.
    db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, price REAL NOT NULL)");
    try {
      const output = await run(configPath, ["--db"]);
      expect(output).toContain(
        '[storage] "item"."price": declared REAL, not the checked scaled-integer decimal storage VibORM writes; typed reads, filters and writes are not checked against it.'
      );
      expect(output).toContain(
        '[storage] "item"."prices": the column is missing'
      );
      expect(output).toContain("Adopt the table through viborm push");
      expect(output).toContain("Storage audited: 2 column(s), 2 need repair.");
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      db.exec(
        "DROP TABLE item; CREATE TABLE item (id INTEGER PRIMARY KEY, price DECIMAL(10,2) NOT NULL, prices TEXT NOT NULL)"
      );
      const prisma = await run(configPath, ["--db"]);
      expect(prisma).toContain('"item"."price": declared DECIMAL(10,2), not');
      expect(prisma).toContain('"item"."prices": declared TEXT, not');
      expect(process.exitCode).toBe(1);

      // A missing table reports each decimal column missing.
      process.exitCode = undefined;
      db.exec("ALTER TABLE item RENAME TO foreign_item");
      const missing = await run(configPath, ["--db"]);
      expect(missing).toContain('"item"."price": the column is missing');
      expect(missing).toContain("Storage audited: 2 column(s), 2 need repair.");
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      db.exec("DROP TABLE foreign_item");
      const item = s
        .model({
          id: s.int().id(),
          price: s.decimal({ precision: 10, scale: 2 }),
          prices: s.decimal({ precision: 10, scale: 2 }).array(),
        })
        .map("item");
      const owner = createClient({ client: db, schema: { item } });
      await syncLiveSchema(owner);
      const result = JSON.parse(await run(configPath, ["--db", "--json"]));
      expect(result.storage).toEqual(
        ["price", "prices"].map((column) => ({
          table: "item",
          column,
          type: "decimal",
          declared: column === "price" ? "INTEGER" : "TEXT",
          checked: true,
        }))
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("--db has no SQLite temporal text to audit on other dialects", async () => {
    project = makeTempProject();
    writeConfigFixture(project, { schemaBody: TEMPORAL });
    expect(await run(project.configPath, ["--db"])).toContain(
      "Storage audited: 0 column(s), 0 need repair."
    );
    expect(process.exitCode).toBeUndefined();
  });
});
