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
    project = makeTempProject();
    writeConfigFixture(project, { dialect: "sqlite3", schemaBody: TEMPORAL });
    const file = join(project.dir, "app.db");
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(
      project.configPath,
      readFileSync(project.configPath, "utf8").replace(
        '":memory:"',
        JSON.stringify(file)
      )
    );
    const db = new Database(file);
    db.exec(`CREATE TABLE event (id INTEGER PRIMARY KEY, title TEXT, at TEXT, clock TEXT, moments TEXT, stamp INTEGER);
      INSERT INTO event VALUES (1, 'canonical', '2024-01-15T10:30:00.000Z', '12:30:00.000', '["2024-01-15T10:30:00.000Z"]', 0);
      INSERT INTO event VALUES (2, 'rc.x', '2024-01-15T10:30:00Z', '12:30:00', '["2024-01-15 10:30:00"]', 0);`);
    try {
      const output = await run(project.configPath, ["--db"]);
      expect(output).toContain(
        '[storage] "event"."at": 1 row(s) of noncanonical DateTime text compare and sort wrongly.'
      );
      expect(output).toContain("Repair with sqliteCanonicalTimeExpression");
      expect(output).toContain("Storage audited: 3 column(s), 3 need repair.");
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      db.exec(
        `UPDATE event SET at = '2024-01-15T10:30:00.000Z', clock = '12:30:00.000', moments = '["2024-01-15T10:30:00.000Z"]'`
      );
      const result = JSON.parse(
        await run(project.configPath, ["--db", "--json"])
      );
      expect(result).toMatchObject({ valid: true, errors: [] });
      expect(result.storage).toEqual(
        [
          ["at", "datetime"],
          ["clock", "time"],
          ["moments", "datetime"],
        ].map(([column, type]) => ({
          table: "event",
          column,
          type,
          noncanonical: 0,
        }))
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("--db audits a pushed schema: a missing table fails the audit", async () => {
    project = makeTempProject();
    writeConfigFixture(project, { dialect: "sqlite3", schemaBody: TEMPORAL });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    // The config's client is a second module instance here, so the code
    // prefix and exit 2 of the built CLI are not observable; the message is.
    await expect(run(project.configPath, ["--db"])).rejects.toThrow("exit");
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Database table or column does not exist")
    );
  });

  it("--db reports SQLite decimal columns that are not VibORM's checked storage", async () => {
    project = makeTempProject();
    writeConfigFixture(project, { dialect: "sqlite3", schemaBody: PRICED });
    const file = join(project.dir, "app.db");
    const { readFileSync, writeFileSync } = await import("node:fs");
    writeFileSync(
      project.configPath,
      readFileSync(project.configPath, "utf8").replace(
        '":memory:"',
        JSON.stringify(file)
      )
    );
    const db = new Database(file);
    // Another tool's table: typed queries never inspect it.
    db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, price REAL NOT NULL)");
    try {
      const output = await run(project.configPath, ["--db"]);
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
      const prisma = await run(project.configPath, ["--db"]);
      expect(prisma).toContain('"item"."price": declared DECIMAL(10,2), not');
      expect(prisma).toContain('"item"."prices": declared TEXT, not');
      expect(process.exitCode).toBe(1);

      // A missing table fails as it fails the temporal scan.
      process.exitCode = undefined;
      db.exec("ALTER TABLE item RENAME TO foreign_item");
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });
      await expect(run(project.configPath, ["--db"])).rejects.toThrow("exit");
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("Database table or column does not exist")
      );

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
      const result = JSON.parse(
        await run(project.configPath, ["--db", "--json"])
      );
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
