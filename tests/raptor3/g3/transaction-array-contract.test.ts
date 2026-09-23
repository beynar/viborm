import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { TransactionError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { PreparedBatchOperation } from "@query-engine/types";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

class ArrayWitnessSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  readonly batches: BatchQuery[][] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

class AtomicArrayWitnessSQLiteDriver extends ArrayWitnessSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries);
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

function arraySchema() {
  const record = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      label: s.string().default("default-label"),
      secret: s.string().default("private"),
      score: s.int().default(0),
    })
    .map("g3_array_records");
  const defaultOnly = s
    .model({ id: s.int().id().increment() })
    .map("g3_array_default_only");
  return { record, defaultOnly };
}

type Candidate = ReturnType<typeof createCommandEngine>;

function prepareCandidateBatch(
  candidate: Candidate,
  model: "record" | "defaultOnly",
  operation: "createMany" | "updateMany" | "deleteMany",
  args: unknown
): Promise<PreparedBatchOperation<unknown> | undefined> {
  return candidate.prepareBatch(model, operation, args);
}

function transactionArray(
  client: object,
  operations: readonly unknown[]
): Promise<unknown[]> {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  return Reflect.apply(transaction, client, [operations]);
}

function packagedOperation(
  source: PromiseLike<unknown>,
  candidate: Candidate,
  model: "record" | "defaultOnly",
  operation: "createMany" | "updateMany" | "deleteMany",
  args: unknown
) {
  return overrideTransactionOperation(source, {
    prepare: () => undefined,
    prepareBatch: () =>
      prepareCandidateBatch(candidate, model, operation, args),
  });
}

describe("G3 C10 atomic package composition", () => {
  it("keeps mixed-shape and default-only result windows isolated in one native batch", async () => {
    const schema = arraySchema();
    const database = new Database(":memory:");
    const driver = new AtomicArrayWitnessSQLiteDriver({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    driver.statements.length = 0;
    driver.batches.length = 0;
    try {
      const mixed = packagedOperation(
        client.record.findMany(),
        candidate,
        "record",
        "createMany",
        {
          data: [
            { id: 100, code: "explicit-first", label: "first" },
            { code: "generated", label: "second" },
            { id: 200, code: "explicit-last", label: "third" },
          ],
          select: { id: true, code: true, label: true },
        }
      );
      const defaults = packagedOperation(
        client.defaultOnly.findMany(),
        candidate,
        "defaultOnly",
        "createMany",
        { data: [{}, {}], select: { id: true } }
      );

      assert.deepEqual(await transactionArray(client, [mixed, defaults]), [
        [
          { id: 100, code: "explicit-first", label: "first" },
          { id: 101, code: "generated", label: "second" },
          { id: 200, code: "explicit-last", label: "third" },
        ],
        [{ id: 1 }, { id: 2 }],
      ]);
      assert.equal(driver.batches.length, 1);
      assert.equal(driver.batches[0]?.length, 5);
      assert.deepEqual(
        database
          .prepare("SELECT id,code,label FROM g3_array_records ORDER BY id")
          .all(),
        [
          { id: 100, code: "explicit-first", label: "first" },
          { id: 101, code: "generated", label: "second" },
          { id: 200, code: "explicit-last", label: "third" },
        ]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("keeps an earlier update result separate when a later delete consumes its rows", async () => {
    const schema = arraySchema();
    const database = new Database(":memory:");
    const driver = new AtomicArrayWitnessSQLiteDriver({ client: database });
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    const candidate = createCommandEngine({ schema, driver });
    database.exec(`
      INSERT INTO g3_array_records(id,code,label,secret,score) VALUES
        (1,'a','one','s1',1),
        (2,'b','two','s2',2),
        (3,'c','three','s3',3);
    `);
    driver.statements.length = 0;
    driver.batches.length = 0;
    try {
      const update = packagedOperation(
        client.record.findMany(),
        candidate,
        "record",
        "updateMany",
        {
          where: { score: { lt: 4 } },
          data: { score: { increment: 10 } },
          limit: 2,
          select: { id: true, score: true },
        }
      );
      const deletion = packagedOperation(
        client.record.findMany(),
        candidate,
        "record",
        "deleteMany",
        { where: { score: { gte: 11 } }, omit: { secret: true } }
      );

      const outcome = await transactionArray(client, [update, deletion]);
      assert.equal(outcome.length, 2);
      const updated = outcome[0];
      const deleted = outcome[1];
      assert.ok(Array.isArray(updated));
      assert.ok(Array.isArray(deleted));
      assert.equal(updated.length, 2);
      assert.deepEqual(
        deleted
          .map((row) => {
            assert(
              row && typeof row === "object" && "id" in row && "score" in row
            );
            return { id: row.id, score: row.score };
          })
          .sort((left, right) => {
            assert.equal(typeof left.id, "number");
            assert.equal(typeof right.id, "number");
            return left.id - right.id;
          }),
        updated
          .map((row) => {
            assert(
              row && typeof row === "object" && "id" in row && "score" in row
            );
            return { id: row.id, score: row.score };
          })
          .sort((left, right) => {
            assert.equal(typeof left.id, "number");
            assert.equal(typeof right.id, "number");
            return left.id - right.id;
          })
      );
      for (const row of deleted) {
        assert(row && typeof row === "object");
        assert.equal("secret" in row, false);
      }
      assert.equal(driver.batches.length, 1);
      assert.equal(driver.batches[0]?.length, 2);
      const storedCount = database
        .prepare("SELECT COUNT(*) AS count FROM g3_array_records")
        .get();
      assert(
        storedCount && typeof storedCount === "object" && "count" in storedCount
      );
      assert.equal(storedCount.count, 1);
    } finally {
      await client.$disconnect();
      database.close();
    }
  });
});

async function createInteractiveWorld(label: string) {
  const schema = arraySchema();
  const database = new Database(":memory:");
  const driver = new ArrayWitnessSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  const candidate = createCommandEngine({ schema, driver });
  driver.statements.length = 0;
  const operation = overrideTransactionOperation(client.record.findMany(), {
    executeWith(transactionDriver) {
      return candidate.execute(
        "record",
        "createMany",
        { data: [{ id: 1, code: label, label }] },
        { kind: "borrowed-transaction", driver: transactionDriver }
      );
    },
  });
  return { candidate, client, database, driver, operation };
}

describe("G3 C10 borrowed binding lifetime", () => {
  it("refuses an escaped transaction driver before candidate provider work", async () => {
    const world = await createInteractiveWorld("inside");
    let escaped: AnyDriver | undefined;
    const capture = overrideTransactionOperation(
      world.client.record.findMany(),
      {
        executeWith(transactionDriver) {
          escaped = transactionDriver;
          return world.candidate.execute(
            "record",
            "createMany",
            { data: [{ id: 1, code: "inside", label: "inside" }] },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        },
      }
    );
    try {
      await transactionArray(world.client, [capture]);
      assert(escaped);
      const providerStatements = world.driver.statements.length;
      await assert.rejects(
        world.candidate.execute(
          "record",
          "createMany",
          { data: [{ id: 2, code: "escaped", label: "escaped" }] },
          { kind: "borrowed-transaction", driver: escaped }
        ),
        (failure) => failure instanceof TransactionError
      );
      assert.equal(world.driver.statements.length, providerStatements);
      assert.deepEqual(
        world.database
          .prepare("SELECT id,code FROM g3_array_records ORDER BY id")
          .all(),
        [{ id: 1, code: "inside" }]
      );
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });

  it("keeps concurrent array compositions on distinct drivers isolated", async () => {
    const left = await createInteractiveWorld("left");
    const right = await createInteractiveWorld("right");
    try {
      assert.deepEqual(
        await Promise.all([
          transactionArray(left.client, [left.operation]),
          transactionArray(right.client, [right.operation]),
        ]),
        [[{ count: 1 }], [{ count: 1 }]]
      );
      assert.deepEqual(
        left.database.prepare("SELECT code FROM g3_array_records").all(),
        [{ code: "left" }]
      );
      assert.deepEqual(
        right.database.prepare("SELECT code FROM g3_array_records").all(),
        [{ code: "right" }]
      );
    } finally {
      await left.client.$disconnect();
      await right.client.$disconnect();
      left.database.close();
      right.database.close();
    }
  });
});
