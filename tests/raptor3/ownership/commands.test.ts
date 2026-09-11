import assert from "node:assert/strict";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { TransactionError, UniqueConstraintError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const record = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g27_records");
const SAVEPOINT = /^SAVEPOINT sp_/;
const RELEASE_SAVEPOINT = /^RELEASE SAVEPOINT sp_/;
const INSERT = /^INSERT INTO /;

class WitnessSQLiteDriver extends SQLite3Driver {
  readonly controlStatements: string[] = [];
  disconnectCalls = 0;
  executeCalls = 0;
  transactionCalls = 0;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.executeCalls++;
    return super.execute<T>(client, statement, parameters);
  }

  protected override async executeRaw<T>(
    client: Database.Database,
    statement: string,
    parameters?: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.controlStatements.push(statement);
    return super.executeRaw<T>(client, statement, parameters);
  }

  protected override async transaction<T>(
    client: Database.Database,
    body: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    this.transactionCalls++;
    return super.transaction(client, body, context);
  }

  override async disconnect(): Promise<void> {
    this.disconnectCalls++;
    return super.disconnect();
  }
}

function world(label: string) {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE g27_records(id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    INSERT INTO g27_records VALUES (1, '${label}');
  `);
  return {
    database,
    driver: new WitnessSQLiteDriver({ client: database }),
  };
}

function labelOf(database: Database.Database): string {
  const label = database
    .prepare("SELECT label FROM g27_records WHERE id = 1")
    .pluck()
    .get();
  if (typeof label !== "string") throw new TypeError("Expected string label");
  return label;
}

async function closeWorld(value: ReturnType<typeof world>) {
  await value.driver.disconnect();
  value.database.close();
}

describe("G2.7 private execution ownership", () => {
  it("reads through the exact borrowed transaction without factory fallback", async () => {
    const factory = world("factory-decoy");
    const borrowed = world("borrowed");
    try {
      const engine = createCommandEngine({
        schema: { record },
        driver: factory.driver,
      });
      const value = await borrowed.driver.withTransaction((driver) =>
        engine.execute(
          "record",
          "findUnique",
          { where: { id: 1 } },
          { kind: "borrowed-transaction", driver }
        )
      );

      assert.deepEqual(value, { id: 1, label: "borrowed" });
      assert.equal(factory.driver.executeCalls, 0);
      assert.equal(factory.driver.transactionCalls, 0);
      assert.equal(borrowed.driver.executeCalls, 1);
      assert.equal(borrowed.driver.transactionCalls, 1);
      assert.equal(borrowed.driver.controlStatements.length, 0);
      assert.equal(borrowed.driver.disconnectCalls, 0);
      assert.equal(factory.driver.disconnectCalls, 0);
    } finally {
      await closeWorld(factory);
      await closeWorld(borrowed);
    }
  });

  it("leaves borrowed write commit and rollback to the caller", async () => {
    const factory = world("factory-decoy");
    const borrowed = world("initial");
    const rollback = new Error("caller rollback");
    try {
      const engine = createCommandEngine({
        schema: { record },
        driver: factory.driver,
      });
      await borrowed.driver.withTransaction(async (driver) => {
        await engine.execute(
          "record",
          "update",
          {
            where: { id: 1 },
            data: { label: "committed" },
            select: { id: true, label: true },
          },
          { kind: "borrowed-transaction", driver }
        );
      });
      assert.equal(labelOf(borrowed.database), "committed");

      await assert.rejects(
        borrowed.driver.withTransaction(async (driver) => {
          await engine.execute(
            "record",
            "update",
            {
              where: { id: 1 },
              data: { label: "rolled-back" },
              select: { id: true, label: true },
            },
            { kind: "borrowed-transaction", driver }
          );
          throw rollback;
        }),
        (failure) => failure === rollback
      );

      assert.equal(labelOf(borrowed.database), "committed");
      assert.equal(labelOf(factory.database), "factory-decoy");
      assert.equal(factory.driver.executeCalls, 0);
      assert.equal(factory.driver.transactionCalls, 0);
      assert.equal(borrowed.driver.transactionCalls, 2);
    } finally {
      await closeWorld(factory);
      await closeWorld(borrowed);
    }
  });

  it("isolates interleaved calls on distinct borrowed drivers", async () => {
    const factory = world("factory-decoy");
    const left = world("left-initial");
    const right = world("right-initial");
    let entered = 0;
    let release: (() => void) | undefined;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const engine = createCommandEngine({
        schema: { record },
        driver: factory.driver,
      });
      const update = (owned: ReturnType<typeof world>, label: string) =>
        owned.driver.withTransaction(async (driver) => {
          entered++;
          if (entered === 2) release?.();
          await bothEntered;
          return engine.execute(
            "record",
            "update",
            { where: { id: 1 }, data: { label } },
            { kind: "borrowed-transaction", driver }
          );
        });

      await Promise.all([update(left, "left"), update(right, "right")]);

      assert.equal(labelOf(left.database), "left");
      assert.equal(labelOf(right.database), "right");
      assert.equal(labelOf(factory.database), "factory-decoy");
      assert.equal(factory.driver.executeCalls, 0);
      assert.equal(left.driver.transactionCalls, 1);
      assert.equal(right.driver.transactionCalls, 1);
    } finally {
      await closeWorld(factory);
      await closeWorld(left);
      await closeWorld(right);
    }
  });

  it("adds no savepoint and honors one explicitly owned by the caller", async () => {
    const factory = world("factory-decoy");
    const borrowed = world("initial");
    try {
      const engine = createCommandEngine({
        schema: { record },
        driver: factory.driver,
      });
      await borrowed.driver.withTransaction(async (driver) => {
        await engine.execute(
          "record",
          "findUnique",
          { where: { id: 1 } },
          { kind: "borrowed-transaction", driver }
        );
        assert.deepEqual(borrowed.driver.controlStatements, []);

        await driver.withTransaction(async (savepointDriver) => {
          await engine.execute(
            "record",
            "update",
            { where: { id: 1 }, data: { label: "inside-savepoint" } },
            { kind: "borrowed-transaction", driver: savepointDriver }
          );
        });
      });

      assert.equal(labelOf(borrowed.database), "inside-savepoint");
      assert.equal(factory.driver.executeCalls, 0);
      assert.equal(borrowed.driver.transactionCalls, 1);
      assert.equal(borrowed.driver.controlStatements.length, 2);
      assert.match(borrowed.driver.controlStatements[0]!, SAVEPOINT);
      assert.match(borrowed.driver.controlStatements[1]!, RELEASE_SAVEPOINT);
    } finally {
      await closeWorld(factory);
      await closeWorld(borrowed);
    }
  });

  it("preserves a normalized recovery-shaped failure without replay", async () => {
    const factory = world("factory-decoy");
    const borrowed = world("initial");
    const cause = new Error("native duplicate");
    const failure = new UniqueConstraintError("already normalized", {
      cause,
      meta: {
        columns: ["id"],
        constraint: "g27_records_pkey",
        statementIndex: 0,
        table: "g27_records",
      },
    });
    const preservedCause = failure.originalCause;
    const preservedMeta = failure.meta;
    let selectorLookups = 0;
    let selectorAbsences = 0;
    let insertAttempts = 0;
    const attemptedStatements: string[] = [];
    try {
      const engine = createCommandEngine({
        schema: { record },
        driver: factory.driver,
      });
      let caught: unknown;
      try {
        await borrowed.driver.withTransaction((driver) => {
          const execute: typeof driver._execute = driver._execute.bind(driver);
          driver._execute = async <T = Record<string, unknown>>(
            statement,
            context
          ): Promise<QueryResult<T>> => {
            const text = statement.strings.join("?");
            attemptedStatements.push(text);
            if (INSERT.test(text)) {
              insertAttempts++;
              throw failure;
            }
            selectorLookups++;
            const response = await execute<T>(statement, context);
            if (response.rows.length === 0) selectorAbsences++;
            return response;
          };
          return engine.execute(
            "record",
            "upsert",
            {
              where: { id: 2 },
              create: { id: 2, label: "failed-insert" },
              update: { label: "must-not-update" },
            },
            { kind: "borrowed-transaction", driver }
          );
        });
      } catch (error) {
        caught = error;
      }

      assert.equal(caught, failure);
      assert.equal(failure.originalCause, preservedCause);
      assert.equal(failure.meta, preservedMeta);
      assert.deepEqual(failure.meta.columns, ["id"]);
      assert.equal(failure.meta.constraint, "g27_records_pkey");
      assert.equal(failure.meta.statementIndex, 0);
      assert.equal(failure.meta.table, "g27_records");
      assert.equal(selectorLookups, 1);
      assert.equal(selectorAbsences, 1);
      assert.equal(insertAttempts, 1);
      assert.equal(attemptedStatements.length, 2);
      assert.match(attemptedStatements[0]!, /^SELECT /);
      assert.match(attemptedStatements[1]!, INSERT);
      assert.equal(borrowed.driver.executeCalls, 1);
      assert.equal(borrowed.driver.transactionCalls, 1);
      assert.equal(borrowed.driver.controlStatements.length, 0);
      assert.equal(borrowed.driver.disconnectCalls, 0);
      assert.equal(factory.driver.executeCalls, 0);
      assert.equal(factory.driver.transactionCalls, 0);
      assert.equal(factory.driver.disconnectCalls, 0);
    } finally {
      await closeWorld(factory);
      await closeWorld(borrowed);
    }
  });

  it("refuses atomic-array binding before admission or provider work", async () => {
    let defaultCalls = 0;
    let inputReads = 0;
    let transformCalls = 0;
    const admitted = s
      .model({
        id: s
          .int()
          .id()
          .default(() => {
            defaultCalls++;
            return 1;
          }),
        label: s.string().schema(
          v.string({
            transform(value) {
              transformCalls++;
              return value;
            },
          })
        ),
      })
      .map("g27_records");
    const factory = world("factory-decoy");
    const rawArgs = new Proxy(
      { data: { label: "must-not-admit" } },
      {
        get(target, property, receiver) {
          inputReads++;
          return Reflect.get(target, property, receiver);
        },
        ownKeys(target) {
          inputReads++;
          return Reflect.ownKeys(target);
        },
      }
    );
    try {
      const engine = createCommandEngine({
        schema: { record: admitted },
        driver: factory.driver,
      });
      await assert.rejects(
        engine.execute("record", "create", rawArgs, { kind: "atomic-array" }),
        TransactionError
      );

      assert.equal(inputReads, 0);
      assert.equal(defaultCalls, 0);
      assert.equal(transformCalls, 0);
      assert.equal(factory.driver.executeCalls, 0);
      assert.equal(factory.driver.transactionCalls, 0);
      assert.equal(factory.driver.disconnectCalls, 0);
    } finally {
      await closeWorld(factory);
    }
  });
});
