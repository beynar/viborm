import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { UniqueConstraintError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

class ObservedSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, parameters });
    return super.execute<T>(client, statement, parameters);
  }
}

class AtomicBatchSQLiteDriver extends ObservedSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCalls = 0;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls++;
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

class NonReturningSQLiteDriver extends ObservedSQLiteDriver {
  override readonly maxBindParametersPerStatement: number | undefined;

  constructor(database: Database.Database, bindLimit?: number) {
    super({ client: database });
    this.maxBindParametersPerStatement = bindLimit;
    this.adapter.capabilities.supportsReturning = false;
  }
}

class BindLimitedSQLiteDriver extends ObservedSQLiteDriver {
  override readonly maxBindParametersPerStatement: number;

  constructor(database: Database.Database, bindLimit: number) {
    super({ client: database });
    this.maxBindParametersPerStatement = bindLimit;
  }
}

function reviewSchema() {
  const record = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      label: s.string().default("default-label"),
    })
    .map("g3_review_records");
  const compound = s
    .model({
      tenant: s.string(),
      slot: s.int(),
      label: s.string(),
    })
    .id(["tenant", "slot"])
    .map("g3_review_compound_records");
  const decimal = s
    .model({
      id: s.decimal({ precision: 12, scale: 2 }).id(),
      label: s.string(),
    })
    .map("g3_review_decimal_records");
  return { compound, decimal, record };
}

function insertStatements(driver: ObservedSQLiteDriver) {
  return driver.statements.filter(({ sql }) => /^INSERT\b/i.test(sql.trim()));
}

function selectStatements(driver: ObservedSQLiteDriver) {
  return driver.statements.filter(({ sql }) => /^SELECT\b/i.test(sql.trim()));
}

describe("G3-02 execution boundary review", () => {
  it("keeps standalone multi-statement createMany on its atomic batch route", async () => {
    const schema = reviewSchema();
    const database = new Database(":memory:");
    const driver = new AtomicBatchSQLiteDriver({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    driver.statements.length = 0;
    try {
      await assert.rejects(
        candidate.execute("record", "createMany", {
          data: [
            { id: 1, code: "first", label: "explicit" },
            { code: "duplicate" },
            { code: "duplicate" },
          ],
        }),
        UniqueConstraintError
      );

      assert.deepEqual(
        database.prepare("SELECT id FROM g3_review_records ORDER BY id").all(),
        []
      );
      assert.equal(driver.batchCalls, 1);
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("reads a supported incremented key when the public result omits it", async () => {
    const schema = reviewSchema();
    const database = new Database(":memory:");
    const driver = new NonReturningSQLiteDriver(database, 8);
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    database.exec(`
      INSERT INTO g3_review_records(id,code,label) VALUES
        (8,'first','value'),
        (18,'second','value'),
        (28,'third','value')
    `);
    driver.statements.length = 0;
    try {
      assert.deepEqual(
        await candidate.execute("record", "updateMany", {
          data: { id: { increment: 2 } },
          select: { code: true },
        }),
        [{ code: "first" }, { code: "second" }, { code: "third" }]
      );
      assert.deepEqual(
        database
          .prepare("SELECT id,code FROM g3_review_records ORDER BY id")
          .all(),
        [
          { id: 10, code: "first" },
          { id: 20, code: "second" },
          { id: 30, code: "third" },
        ]
      );
      const terminals = selectStatements(driver).filter(({ sql }) =>
        /["`]code["`]/i.test(sql)
      );
      assert.equal(terminals.length, 3);
      assert.equal(
        terminals.every(({ parameters }) => parameters.length <= 8),
        true
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("reads through a supported compound key transition with omitted result keys", async () => {
    const schema = reviewSchema();
    const database = new Database(":memory:");
    const driver = new NonReturningSQLiteDriver(database, 8);
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    database.exec(`
      INSERT INTO g3_review_compound_records(tenant,slot,label) VALUES
        ('old',8,'first'),
        ('old',18,'second')
    `);
    driver.statements.length = 0;
    try {
      assert.deepEqual(
        await candidate.execute("compound", "updateMany", {
          where: { tenant: "old" },
          data: { tenant: "new", slot: { increment: 2 } },
          select: { label: true },
        }),
        [{ label: "first" }, { label: "second" }]
      );
      assert.deepEqual(
        database
          .prepare(
            "SELECT tenant,slot,label FROM g3_review_compound_records"
          )
          .all(),
        [
          { tenant: "new", slot: 10, label: "first" },
          { tenant: "new", slot: 20, label: "second" },
        ]
      );
      const terminals = selectStatements(driver).filter(({ sql }) =>
        /["`]label["`]/i.test(sql)
      );
      assert.equal(terminals.length, 2);
      assert.equal(
        terminals.every(({ sql, parameters }) =>
          /\+/.test(sql) && parameters.length <= 8
        ),
        true
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("reads a supported decimal key increment through its provider expression", async () => {
    const schema = reviewSchema();
    const database = new Database(":memory:");
    const driver = new NonReturningSQLiteDriver(database);
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    database.exec(
      "INSERT INTO g3_review_decimal_records(id,label) VALUES(800,'value')"
    );
    driver.statements.length = 0;
    try {
      assert.deepEqual(
        await candidate.execute("decimal", "updateMany", {
          where: { id: "8.00" },
          data: { id: { increment: "2.00" } },
          select: { label: true },
        }),
        [{ label: "value" }]
      );
      assert.deepEqual(
        database
          .prepare("SELECT id,label FROM g3_review_decimal_records")
          .all(),
        [{ id: 1000, label: "value" }]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("partitions set inserts by compiled bind count and preserves result order", async () => {
    const schema = reviewSchema();
    const database = new Database(":memory:");
    const driver = new BindLimitedSQLiteDriver(database, 6);
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    driver.statements.length = 0;
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      code: `code-${index + 1}`,
      label: `label-${index + 1}`,
    }));
    try {
      assert.deepEqual(
        await candidate.execute("record", "createMany", {
          data: rows,
          select: { id: true, code: true },
        }),
        rows.map(({ id, code }) => ({ id, code }))
      );
      assert.deepEqual(
        insertStatements(driver).map(({ parameters }) => parameters.length),
        [6, 6, 3]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("partitions non-returning terminal reads by bind count and preserves input order", async () => {
    const schema = reviewSchema();
    const database = new Database(":memory:");
    const driver = new NonReturningSQLiteDriver(database, 5);
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    driver.statements.length = 0;
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      code: `code-${index + 1}`,
      label: `label-${index + 1}`,
    }));
    try {
      assert.deepEqual(
        await candidate.execute("record", "createMany", {
          data: rows,
          select: { id: true, code: true },
        }),
        rows.map(({ id, code }) => ({ id, code }))
      );
      assert.deepEqual(
        selectStatements(driver).map(({ parameters }) => parameters.length),
        [4, 4, 4, 4, 4]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });
});
