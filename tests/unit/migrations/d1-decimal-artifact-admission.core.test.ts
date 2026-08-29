/**
 * A generated SQLite artifact is portable across the SQLite estate, so D1 can
 * receive a descriptor-change rebuild rendered earlier through SQLite3 or
 * LibSQL. The live renderer's D1 refusal cannot protect that path: apply reads
 * the stored SQL and never renders its operations again.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { apply, generate, push } from "@migrations";
import type {
  AlterColumnOperation,
  CreateTableOperation,
  DropForeignKeyOperation,
  RenameTableOperation,
} from "@migrations/drivers";
import {
  sqlite3MigrationDriver,
  sqliteTableBearsRelations,
} from "@migrations/drivers/sqlite";
import { generatedSqliteDecimalRebuilds } from "@migrations/drivers/sqlite/artifact-admission";
import { formatMigrationContent } from "@migrations/generate/file-writer";
import { createMigrationEntry } from "@migrations/storage";
import type {
  MigrationEntry,
  MigrationJournal,
  SchemaSnapshot,
} from "@migrations/types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { ddlContextFor, MemoryStorage } from "./_estate";

class BatchOnlySQLite3Driver extends SQLite3Driver {
  override readonly driverName = "d1";
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

class TransactionalBatchSQLite3Driver extends SQLite3Driver {
  override readonly driverName = "d1";
  override readonly supportsBatch = true;
}

class ExpandingJournalStorage extends MemoryStorage {
  private readonly initial: MigrationJournal;
  private readonly expanded: MigrationJournal;
  private journalReads = 0;

  constructor(initial: MigrationJournal, expanded: MigrationJournal) {
    super();
    this.initial = initial;
    this.expanded = expanded;
  }

  override get(path: string): Promise<string | null> {
    if (path !== "meta/_journal.json") return super.get(path);
    this.journalReads++;
    return Promise.resolve(
      JSON.stringify(this.journalReads <= 2 ? this.initial : this.expanded)
    );
  }
}

type DecimalOwner = "ledger" | "entry";
const CALLBACK_TRANSACTION_UNSUPPORTED =
  /does not support callback transactions/;
const RENAMED_TABLE_BATCH_REFUSAL =
  /generated fixed-decimal migration.*d1_decimal_account.*native batch/s;
const POST_COMMIT_BATCH_REFUSAL =
  /generated fixed-decimal migration.*widen-amount.*native batch/s;
const RELATION_CASES: ReadonlyArray<readonly [string, DecimalOwner, string]> = [
  ["inbound", "ledger", "d1_decimal_ledger"],
  ["outbound", "entry", "d1_decimal_entry"],
];

function relatedLedger(precision: number, decimalOwner: DecimalOwner) {
  const ledger = s
    .model({
      id: s.string().id(),
      amount:
        decimalOwner === "ledger"
          ? s.decimal({ precision, scale: 2 }).nullable()
          : s.string().nullable(),
      entries: s.toMany(() => entry),
    })
    .map("d1_decimal_ledger");
  const entry = s
    .model({
      id: s.string().id(),
      ledgerId: s.string(),
      amount:
        decimalOwner === "entry"
          ? s.decimal({ precision, scale: 2 }).nullable()
          : s.string().nullable(),
      ledger: s
        .toOne(() => ledger)
        .fields("ledgerId")
        .references("id")
        .onDelete("cascade"),
    })
    .map("d1_decimal_entry");
  return { ledger, entry };
}

async function descriptorChangeArtifact(
  decimalOwner: DecimalOwner = "ledger"
): Promise<{
  readonly entry: NonNullable<Awaited<ReturnType<typeof generate>>["entry"]>;
  readonly content: string;
}> {
  const storage = new MemoryStorage();
  const renderer = createInMemorySQLite3Driver();
  await generate(
    { $schema: relatedLedger(10, decimalOwner), $driver: renderer },
    { storageDriver: storage, name: "init" }
  );
  const changed = await generate(
    { $schema: relatedLedger(12, decimalOwner), $driver: renderer },
    { storageDriver: storage, name: "widen-amount" }
  );
  if (changed.entry === null) throw new Error("missing generated migration");
  const content = await storage.readMigration(changed.entry);
  if (content === null) throw new Error("missing generated artifact");
  await renderer.disconnect();
  return { entry: changed.entry, content };
}

async function trackingTableExists(driver: SQLite3Driver): Promise<boolean> {
  const found = await driver._executeRaw<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_viborm_migrations'"
  );
  return found.rows.length > 0;
}

function generatedArtifact(
  name: string,
  statements: readonly string[],
  idx = 0
): { readonly entry: MigrationEntry; readonly content: string } {
  const entry = createMigrationEntry(idx, name, statements.join("\n"), {
    mode: "generated",
    rollback: { kind: "automatic" },
  });
  return {
    entry,
    content: formatMigrationContent(entry, [...statements], "sqlite"),
  };
}

function artifactStatements(...ddlPrograms: readonly string[]): string[] {
  return ddlPrograms.flatMap((ddl) =>
    ddl.split(";\n").map((statement) => `${statement};`)
  );
}

describe("D1 admission of generated SQLite decimal rebuild artifacts", () => {
  for (const [direction, decimalOwner, rebuiltTable] of RELATION_CASES) {
    it(`refuses an ${direction}-FK rebuild before the tracking table or artifact`, async () => {
      const driver = new BatchOnlySQLite3Driver({ dataDir: ":memory:" });
      const before = createClient({
        schema: relatedLedger(10, decimalOwner),
        driver,
      });
      await push(before, { force: true });
      await driver._executeRaw(
        `INSERT INTO "d1_decimal_ledger" ("id", "amount") VALUES ('l1', ${decimalOwner === "ledger" ? "12345" : "NULL"})`
      );
      await driver._executeRaw(
        `INSERT INTO "d1_decimal_entry" ("id", "ledgerId", "amount") VALUES ('e1', 'l1', ${decimalOwner === "entry" ? "12345" : "NULL"})`
      );

      const generated = await descriptorChangeArtifact(decimalOwner);
      const storage = new MemoryStorage();
      await storage.writeMigration(generated.entry, generated.content);
      await storage.writeJournal({
        version: "3",
        target: { dialect: "sqlite" },
        entries: [generated.entry],
      });

      const after = createClient({
        schema: relatedLedger(12, decimalOwner),
        driver,
      });
      await expect(apply(after, { storageDriver: storage })).rejects.toThrow(
        new RegExp(
          `generated fixed-decimal migration.*${rebuiltTable}.*native batch.*before any statement from it runs`,
          "s"
        )
      );
      expect(await trackingTableExists(driver)).toBe(false);
      const coefficients = await driver._executeRaw<{ amount: number }>(
        `SELECT "amount" FROM "${rebuiltTable}" WHERE "id" = '${decimalOwner === "ledger" ? "l1" : "e1"}'`
      );
      const children = await driver._executeRaw<{ id: string }>(
        `SELECT "id" FROM "d1_decimal_entry" WHERE "id" = 'e1'`
      );
      expect(coefficients.rows).toEqual([{ amount: 12_345 }]);
      expect(children.rows).toEqual([{ id: "e1" }]);
      await after.$disconnect();
    });
  }

  it("recognizes the generated decimal-rename rebuild but not an unrelated rebuild", () => {
    const snapshot: SchemaSnapshot = {
      tables: [
        {
          name: "ledger",
          columns: [
            { name: "id", type: "TEXT", nullable: false },
            {
              name: "amount",
              type: "INTEGER",
              nullable: false,
              decimal: { precision: 10, scale: 2 },
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
      enums: [],
    };
    const rename = sqlite3MigrationDriver
      .generateDDL(
        {
          type: "renameColumn",
          tableName: "ledger",
          from: "amount",
          to: "balance",
        },
        ddlContextFor("artifact", snapshot)
      )
      .split(";\n")
      .map((statement) => `${statement};`);
    const unrelated = sqlite3MigrationDriver
      .generateDDL(
        {
          type: "addUniqueConstraint",
          tableName: "ledger",
          constraint: { name: "ledger_amount_key", columns: ["amount"] },
        },
        ddlContextFor("artifact", snapshot)
      )
      .split(";\n")
      .map((statement) => `${statement};`);

    expect(
      generatedSqliteDecimalRebuilds(rename).map((rebuild) => rebuild.table)
    ).toEqual(["ledger"]);
    expect(generatedSqliteDecimalRebuilds(unrelated)).toEqual([]);
  });

  it("does not read sentinel bytes from a mapped identifier as a conversion", () => {
    const sentinelIdentifier = "'viborm:decimal-out-of-domain'";
    const snapshot: SchemaSnapshot = {
      tables: [
        {
          name: "ledger",
          columns: [
            { name: "id", type: "TEXT", nullable: false },
            {
              name: "amount",
              type: "INTEGER",
              nullable: false,
              decimal: { precision: 10, scale: 2 },
            },
            { name: sentinelIdentifier, type: "TEXT", nullable: true },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
      enums: [],
    };
    const unrelated = sqlite3MigrationDriver
      .generateDDL(
        {
          type: "addUniqueConstraint",
          tableName: "ledger",
          constraint: {
            name: "ledger_mapped_key",
            columns: [sentinelIdentifier],
          },
        },
        ddlContextFor("artifact", snapshot)
      )
      .split(";\n")
      .map((statement) => `${statement};`);
    const commented = unrelated.map((statement) =>
      statement.startsWith("INSERT INTO ")
        ? `${statement.slice(0, -1)} -- 'viborm:decimal-list-out-of-domain'\n;`
        : statement
    );

    expect(generatedSqliteDecimalRebuilds(unrelated)).toEqual([]);
    expect(generatedSqliteDecimalRebuilds(commented)).toEqual([]);
  });

  it("keeps every generated decimal rebuild of the same table", () => {
    const snapshot: SchemaSnapshot = {
      tables: [
        {
          name: "ledger",
          columns: [
            { name: "id", type: "TEXT", nullable: false },
            {
              name: "amount",
              type: "INTEGER",
              nullable: false,
              decimal: { precision: 10, scale: 2 },
            },
            {
              name: "tax",
              type: "INTEGER",
              nullable: false,
              decimal: { precision: 10, scale: 2 },
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
      enums: [],
    };
    const ledger = snapshot.tables[0];
    const amount = ledger?.columns[1];
    const tax = ledger?.columns[2];
    if (amount === undefined || tax === undefined) {
      throw new Error("missing decimal columns");
    }
    const first: AlterColumnOperation = {
      type: "alterColumn",
      tableName: "ledger",
      columnName: "amount",
      from: amount,
      to: {
        name: "amount",
        type: "INTEGER",
        nullable: false,
        decimal: { precision: 12, scale: 2 },
      },
    };
    const second: AlterColumnOperation = {
      type: "alterColumn",
      tableName: "ledger",
      columnName: "tax",
      from: tax,
      to: {
        name: "tax",
        type: "INTEGER",
        nullable: false,
        decimal: { precision: 12, scale: 2 },
      },
    };
    const statements = artifactStatements(
      sqlite3MigrationDriver.generateDDL(
        first,
        ddlContextFor("artifact", snapshot)
      ),
      sqlite3MigrationDriver.generateDDL(second, {
        ...ddlContextFor("artifact", snapshot),
        precedingOperations: [first],
      })
    );

    expect(
      generatedSqliteDecimalRebuilds(statements).map((rebuild) => rebuild.table)
    ).toEqual(["ledger", "ledger"]);
  });

  it("replays generated relation creation and removal before each census", () => {
    const decimalColumn = {
      name: "amount",
      type: "INTEGER",
      nullable: false,
      decimal: { precision: 10, scale: 2 },
    };
    const targetDecimalColumn = {
      ...decimalColumn,
      decimal: { precision: 12, scale: 2 },
    };
    const relationFree: SchemaSnapshot = {
      tables: [
        {
          name: "ledger",
          columns: [
            { name: "id", type: "TEXT", nullable: false },
            decimalColumn,
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
      enums: [],
    };
    const relationFreeLedger = relationFree.tables[0];
    if (relationFreeLedger === undefined) {
      throw new Error("missing relation-free ledger");
    }
    const createChild: CreateTableOperation = {
      type: "createTable",
      table: {
        name: "entry",
        columns: [{ name: "ledger_id", type: "TEXT", nullable: false }],
        indexes: [],
        uniqueConstraints: [],
        foreignKeys: [
          {
            name: "entry_ledger_fk",
            columns: ["ledger_id"],
            referencedTable: "ledger",
            referencedColumns: ["id"],
          },
        ],
      },
    };
    const alter: AlterColumnOperation = {
      type: "alterColumn",
      tableName: "ledger",
      columnName: "amount",
      from: decimalColumn,
      to: targetDecimalColumn,
    };
    const createdRelationStatements = artifactStatements(
      sqlite3MigrationDriver.generateDDL(
        createChild,
        ddlContextFor("artifact", relationFree)
      ),
      sqlite3MigrationDriver.generateDDL(alter, {
        ...ddlContextFor("artifact", relationFree),
        precedingOperations: [createChild],
      })
    );
    const createdRelation = generatedSqliteDecimalRebuilds(
      createdRelationStatements
    )[0];
    if (createdRelation === undefined) {
      throw new Error("missing relation-creation rebuild");
    }
    expect(
      sqliteTableBearsRelations(
        createdRelation.table,
        relationFree.tables,
        undefined,
        createdRelation.precedingOperations
      )
    ).toBe(true);

    const related: SchemaSnapshot = {
      tables: [
        {
          name: "account",
          columns: [{ name: "id", type: "TEXT", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          ...relationFreeLedger,
          foreignKeys: [
            {
              name: "ledger_account_fk",
              columns: ["id"],
              referencedTable: "account",
              referencedColumns: ["id"],
            },
          ],
        },
      ],
      enums: [],
    };
    const dropRelation: DropForeignKeyOperation = {
      type: "dropForeignKey",
      tableName: "ledger",
      fkName: "ledger_account_fk",
    };
    const removedRelationStatements = artifactStatements(
      sqlite3MigrationDriver.generateDDL(
        dropRelation,
        ddlContextFor("artifact", related)
      ),
      sqlite3MigrationDriver.generateDDL(alter, {
        ...ddlContextFor("artifact", related),
        precedingOperations: [dropRelation],
      })
    );
    const removedRelation = generatedSqliteDecimalRebuilds(
      removedRelationStatements
    )[0];
    if (removedRelation === undefined) {
      throw new Error("missing relation-removal rebuild");
    }
    expect(
      sqliteTableBearsRelations(
        removedRelation.table,
        related.tables,
        undefined,
        removedRelation.precedingOperations
      )
    ).toBe(false);
  });

  it("replays a same-artifact table rename before the live relation census", async () => {
    const driver = new BatchOnlySQLite3Driver({ dataDir: ":memory:" });
    const before = createClient({
      schema: relatedLedger(10, "ledger"),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "d1_decimal_ledger" ("id", "amount") VALUES ('l1', 12345)`
    );
    await driver._executeRaw(
      `INSERT INTO "d1_decimal_entry" ("id", "ledgerId") VALUES ('e1', 'l1')`
    );

    const current = await sqlite3MigrationDriver.introspect((sql, params) =>
      driver._executeRaw(sql, params)
    );
    const currentLedger = current.tables.find(
      (table) => table.name === "d1_decimal_ledger"
    );
    const amount = currentLedger?.columns.find(
      (column) => column.name === "amount"
    );
    if (amount === undefined) throw new Error("missing amount column");
    const rename: RenameTableOperation = {
      type: "renameTable",
      from: "d1_decimal_ledger",
      to: "d1_decimal_account",
    };
    const statements = [
      `${sqlite3MigrationDriver.generateDDL(rename, ddlContextFor("artifact", current))};`,
      ...sqlite3MigrationDriver
        .generateDDL(
          {
            type: "alterColumn",
            tableName: "d1_decimal_account",
            columnName: "amount",
            from: amount,
            to: { ...amount, decimal: { precision: 12, scale: 2 } },
          },
          {
            ...ddlContextFor("artifact", current),
            precedingOperations: [rename],
          }
        )
        .split(";\n")
        .map((statement) => `${statement};`),
    ];
    const artifact = generatedArtifact("rename-and-widen", statements);
    const storage = new MemoryStorage();
    await storage.writeMigration(artifact.entry, artifact.content);
    await storage.writeJournal({
      version: "3",
      target: { dialect: "sqlite" },
      entries: [artifact.entry],
    });

    await expect(apply(before, { storageDriver: storage })).rejects.toThrow(
      RENAMED_TABLE_BATCH_REFUSAL
    );
    expect(await trackingTableExists(driver)).toBe(false);
    const parent = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "d1_decimal_ledger" WHERE "id" = 'l1'`
    );
    const child = await driver._executeRaw<{ id: string }>(
      `SELECT "id" FROM "d1_decimal_entry" WHERE "id" = 'e1'`
    );
    expect(parent.rows).toEqual([{ amount: 12_345 }]);
    expect(child.rows).toEqual([{ id: "e1" }]);
    await before.$disconnect();
  });

  it("checks an artifact first seen on a post-commit journal cache miss", async () => {
    const driver = new TransactionalBatchSQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({
      schema: relatedLedger(10, "ledger"),
      driver,
    });
    await push(client, { force: true });
    await driver._executeRaw(
      `INSERT INTO "d1_decimal_ledger" ("id", "amount") VALUES ('l1', 12345)`
    );
    await driver._executeRaw(
      `INSERT INTO "d1_decimal_entry" ("id", "ledgerId") VALUES ('e1', 'l1')`
    );

    const first = generatedArtifact("safe-first", [
      `CREATE TABLE "d1_apply_safe" ("id" TEXT);`,
    ]);
    const unsafe = await descriptorChangeArtifact("ledger");
    const initial: MigrationJournal = {
      version: "3",
      target: { dialect: "sqlite" },
      entries: [first.entry],
    };
    const expanded: MigrationJournal = {
      ...initial,
      entries: [first.entry, unsafe.entry],
    };
    const storage = new ExpandingJournalStorage(initial, expanded);
    await storage.writeMigration(first.entry, first.content);
    await storage.writeMigration(unsafe.entry, unsafe.content);

    await expect(apply(client, { storageDriver: storage })).rejects.toThrow(
      POST_COMMIT_BATCH_REFUSAL
    );
    const tracked = await driver._executeRaw<{ name: string }>(
      `SELECT "name" FROM "_viborm_migrations" ORDER BY "name"`
    );
    const parent = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "d1_decimal_ledger" WHERE "id" = 'l1'`
    );
    const child = await driver._executeRaw<{ id: string }>(
      `SELECT "id" FROM "d1_decimal_entry" WHERE "id" = 'e1'`
    );
    expect(tracked.rows).toEqual([{ name: "safe-first" }]);
    expect(parent.rows).toEqual([{ amount: 12_345 }]);
    expect(child.rows).toEqual([{ id: "e1" }]);
    await client.$disconnect();
  });

  it("leaves a manual artifact outside generated-artifact admission", async () => {
    const driver = new BatchOnlySQLite3Driver({ dataDir: ":memory:" });
    const before = createClient({
      schema: relatedLedger(10, "ledger"),
      driver,
    });
    // Fresh fixed-decimal DDL remains admitted on the same batch-only target.
    await push(before, { force: true });

    const generated = await descriptorChangeArtifact("ledger");
    const manualEntry: MigrationEntry = {
      ...generated.entry,
      mode: "manual",
    };
    const storage = new MemoryStorage();
    await storage.writeMigration(manualEntry, generated.content);
    await storage.writeJournal({
      version: "3",
      target: { dialect: "sqlite" },
      entries: [manualEntry],
    });

    const after = createClient({
      schema: relatedLedger(12, "ledger"),
      driver,
    });
    // This is the pre-existing D1 apply boundary after admission: apply creates
    // its tracking table, then the driver refuses a callback transaction. The
    // new generated-artifact gate must not replace that behavior for manual SQL.
    await expect(apply(after, { storageDriver: storage })).rejects.toThrow(
      CALLBACK_TRANSACTION_UNSUPPORTED
    );
    expect(await trackingTableExists(driver)).toBe(true);
    await after.$disconnect();
  });
});
