import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  TransactionError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { PreparedBatchOperation } from "@query-engine/types";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const setRecord = s
  .model({
    id: s.int().id(),
    cohort: s.string(),
    label: s.string(),
    score: s.int(),
  })
  .map("g3p03_set_records");

const packageParent = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
    children: s.toMany(() => packageChild),
  })
  .map("g3p03_package_parents");

const packageChild = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
    parentId: s.int(),
    parent: s
      .toOne(() => packageParent)
      .fields("parentId")
      .references("id"),
  })
  .map("g3p03_package_children");

const packageSchema = { packageParent, packageChild };

class RecordingSQLiteDriver extends SQLite3Driver {
  readonly statements: { sql: string; context?: QueryExecutionContext }[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, context });
    return super.execute<T>(client, statement, parameters);
  }
}

class BatchOnlySQLiteDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batches: BatchQuery[][] = [];

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

type Candidate = ReturnType<typeof createCommandEngine>;

function prepareCandidateBatch(
  candidate: Candidate,
  model: string,
  operation: "create" | "createMany" | "updateMany" | "deleteMany",
  args: unknown
): Promise<PreparedBatchOperation<unknown> | undefined> {
  const prepare = Reflect.get(candidate, "prepareBatch");
  assert.equal(
    typeof prepare,
    "function",
    "G3P-03 candidate preparation capability is missing"
  );
  return Reflect.apply(prepare, candidate, [model, operation, args]);
}

function transactionArray(
  client: object,
  operations: readonly unknown[]
): Promise<unknown[]> {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  return Reflect.apply(transaction, client, [operations]);
}

function createPackageDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE g3p03_package_parents(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL
    );
    CREATE TABLE g3p03_package_children(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      parentId INTEGER NOT NULL REFERENCES g3p03_package_parents(id)
    );
  `);
  return database;
}

describe("G3P-03 scalar set mutation", () => {
  it("keeps scalar INSERT, UPDATE and DELETE set-oriented with counts and returning", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE g3p03_set_records(
        id INTEGER PRIMARY KEY,
        cohort TEXT NOT NULL,
        label TEXT NOT NULL,
        score INTEGER NOT NULL
      );
    `);
    const driver = new RecordingSQLiteDriver({ client: database });
    const candidate = createCommandEngine({ schema: { setRecord }, driver });
    try {
      await expect(
        candidate.execute("setRecord", "createMany", {
          data: [
            { id: 1, cohort: "keep", label: "first", score: 10 },
            { id: 2, cohort: "keep", label: "second", score: 20 },
            { id: 3, cohort: "drop", label: "third", score: 30 },
          ],
        })
      ).resolves.toEqual({ count: 3 });

      await expect(
        candidate.execute("setRecord", "updateMany", {
          where: { cohort: "keep" },
          data: { label: { set: "updated" }, score: { increment: 2 } },
        })
      ).resolves.toEqual({ count: 2 });

      await expect(
        candidate.execute("setRecord", "deleteMany", {
          where: { cohort: "drop" },
        })
      ).resolves.toEqual({ count: 1 });

      await expect(
        candidate.execute("setRecord", "createMany", {
          data: [
            { id: 4, cohort: "return", label: "fourth", score: 40 },
            { id: 5, cohort: "return", label: "fifth", score: 50 },
          ],
          select: { id: true, label: true },
        })
      ).resolves.toEqual([
        { id: 4, label: "fourth" },
        { id: 5, label: "fifth" },
      ]);

      const mutations = driver.statements.filter(({ sql }) =>
        /^(INSERT|UPDATE|DELETE)\b/.test(sql)
      );
      assert.equal(mutations.length, 4);
      assert.match(
        mutations[0]!.sql,
        /VALUES\s*\([^)]*\),\s*\([^)]*\),\s*\([^)]*\)/
      );
      assert.match(mutations[1]!.sql, /^UPDATE\b/);
      assert.match(mutations[2]!.sql, /^DELETE\b/);
      assert.match(mutations[3]!.sql, /RETURNING/);
      assert.equal(
        driver.statements.some(({ sql }) => /^SELECT\b/.test(sql)),
        false,
        "scalar set mutations must not select rows to mutate them one by one"
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});

describe("G3P-03 existing array-owner composition", () => {
  it("keeps an empty set package complete with a zero-width result window", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE g3p03_set_records(
        id INTEGER PRIMARY KEY,
        cohort TEXT NOT NULL,
        label TEXT NOT NULL,
        score INTEGER NOT NULL
      );
    `);
    const driver = new BatchOnlySQLiteDriver({ client: database });
    const client = createClient({ schema: { setRecord }, driver });
    const candidate = createCommandEngine({ schema: { setRecord }, driver });
    const operation = (args: unknown) =>
      overrideTransactionOperation(client.setRecord.findMany(), {
        prepare: () => undefined,
        prepareBatch: () =>
          prepareCandidateBatch(candidate, "setRecord", "createMany", args),
      });
    try {
      const emptyCount = await prepareCandidateBatch(
        candidate,
        "setRecord",
        "createMany",
        { data: [] }
      );
      assert.ok(emptyCount);
      assert.equal(emptyCount.queries.length, 0);
      assert.deepEqual(emptyCount.parseResult([]), { count: 0 });

      const emptySelected = await prepareCandidateBatch(
        candidate,
        "setRecord",
        "createMany",
        { data: [], select: { id: true, label: true } }
      );
      assert.ok(emptySelected);
      assert.equal(emptySelected.queries.length, 0);
      assert.deepEqual(emptySelected.parseResult([]), []);

      await expect(
        transactionArray(client, [
          operation({ data: [], select: { id: true, label: true } }),
          operation({
            data: [{ id: 1, cohort: "kept", label: "inserted", score: 10 }],
          }),
        ])
      ).resolves.toEqual([[], { count: 1 }]);

      assert.equal(driver.batches.length, 1);
      assert.equal(driver.batches[0]!.length, 1);
      assert.match(driver.batches[0]![0]!.sql, /^INSERT\b/);
      assert.deepEqual(
        database.prepare("SELECT * FROM g3p03_set_records").all(),
        [{ id: 1, cohort: "kept", label: "inserted", score: 10 }]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("merges two complete candidate packages with isolated scratch and result windows", async () => {
    const database = createPackageDatabase();
    const driver = new BatchOnlySQLiteDriver({ client: database });
    const client = createClient({ schema: packageSchema, driver });
    const candidate = createCommandEngine({ schema: packageSchema, driver });
    const packages: PreparedBatchOperation<unknown>[] = [];
    const operation = (label: string) => {
      const source = client.packageParent.findMany();
      return overrideTransactionOperation(source, {
        prepare: () => undefined,
        prepareBatch: async () => {
          const prepared = await prepareCandidateBatch(
            candidate,
            "packageParent",
            "create",
            {
              data: {
                label,
                children: { create: { label: `${label}-child` } },
              },
              select: { id: true, label: true },
            }
          );
          if (prepared) packages.push(prepared);
          return prepared;
        },
      });
    };
    try {
      await expect(
        transactionArray(client, [operation("left"), operation("right")])
      ).resolves.toEqual([
        { id: 1, label: "left" },
        { id: 2, label: "right" },
      ]);

      assert.equal(driver.batches.length, 1);
      assert.equal(packages.length, 2);
      const scratchNames = packages.map((prepared) => {
        const identifiers = prepared.queries.flatMap((query) =>
          query.params.filter(
            (parameter): parameter is string =>
              typeof parameter === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                parameter
              )
          )
        );
        assert.equal(
          new Set(identifiers).size,
          1,
          "each generated-id package must own one scratch identifier"
        );
        return identifiers[0]!;
      });
      assert.notEqual(scratchNames[0], scratchNames[1]);
      assert.deepEqual(
        database
          .prepare("SELECT id, label FROM g3p03_package_parents ORDER BY id")
          .all(),
        [
          { id: 1, label: "left" },
          { id: 2, label: "right" },
        ]
      );
      assert.deepEqual(
        database
          .prepare(
            "SELECT id, label, parentId FROM g3p03_package_children ORDER BY id"
          )
          .all(),
        [
          { id: 1, label: "left-child", parentId: 1 },
          { id: 2, label: "right-child", parentId: 2 },
        ]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("refuses the whole native array when one selected-series member is incomplete", async () => {
    const database = createPackageDatabase();
    database.exec(`
      INSERT INTO g3p03_package_parents(id, label) VALUES (10, 'existing');
    `);
    const driver = new BatchOnlySQLiteDriver({ client: database });
    const client = createClient({ schema: packageSchema, driver });
    const candidate = createCommandEngine({ schema: packageSchema, driver });
    const complete = overrideTransactionOperation(
      client.packageParent.findMany(),
      {
        prepare: () => undefined,
        prepareBatch: () =>
          prepareCandidateBatch(candidate, "packageParent", "create", {
            data: { label: "must-not-dispatch" },
          }),
      }
    );
    const incomplete = overrideTransactionOperation(
      client.packageParent.findMany(),
      {
        prepare: () => undefined,
        prepareBatch: () =>
          prepareCandidateBatch(candidate, "packageParent", "updateMany", {
            where: { id: 10 },
            data: {
              children: { create: { label: "dynamic-child" } },
            },
          }),
      }
    );
    try {
      await expect(
        prepareCandidateBatch(candidate, "packageParent", "create", {
          data: { label: 42 },
        })
      ).rejects.toBeInstanceOf(ValidationError);
      assert.equal(
        driver.batches.length,
        0,
        "validation failures must surface before candidate batch dispatch"
      );
      await expect(
        prepareCandidateBatch(candidate, "packageParent", "updateMany", {
          where: { id: 10 },
          data: {
            children: { create: { label: "dynamic-child" } },
          },
        })
      ).resolves.toBeUndefined();
      await expect(
        transactionArray(client, [complete, incomplete])
      ).rejects.toBeInstanceOf(TransactionError);
      assert.equal(driver.batches.length, 0);
      assert.deepEqual(
        database
          .prepare("SELECT id, label FROM g3p03_package_parents ORDER BY id")
          .all(),
        [{ id: 10, label: "existing" }]
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("attributes a nested package failure to its exact member statement", async () => {
    const database = createPackageDatabase();
    database.exec(`
      CREATE UNIQUE INDEX g3p03_package_child_label
      ON g3p03_package_children(label);
    `);
    const driver = new BatchOnlySQLiteDriver({ client: database });
    const client = createClient({ schema: packageSchema, driver });
    const candidate = createCommandEngine({ schema: packageSchema, driver });
    const operation = (parent: string, child: string) =>
      overrideTransactionOperation(client.packageParent.findMany(), {
        prepare: () => undefined,
        prepareBatch: () =>
          prepareCandidateBatch(candidate, "packageParent", "create", {
            data: {
              label: parent,
              children: { create: { label: child } },
            },
          }),
      });
    try {
      await expect(
        transactionArray(client, [
          operation("first", "duplicate"),
          operation("second", "duplicate"),
        ])
      ).rejects.toMatchObject({
        meta: {
          model: "packageChild",
          operation: "create",
          statementIndex: expect.any(Number),
        },
      });
      assert.equal(driver.batches.length, 1);
      assert.deepEqual(
        database.prepare("SELECT * FROM g3p03_package_parents").all(),
        []
      );
      assert.deepEqual(
        database.prepare("SELECT * FROM g3p03_package_children").all(),
        []
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });
});

describe("G3P-03 updateMany capability refusal", () => {
  it("refuses limit and returning before scalar or relation execution", async () => {
    const database = createPackageDatabase();
    database.exec(`
      INSERT INTO g3p03_package_parents(id, label) VALUES (10, 'existing');
    `);
    const driver = new RecordingSQLiteDriver({ client: database });
    const candidate = createCommandEngine({ schema: packageSchema, driver });
    const refusals = [
      { name: "limit", option: { limit: 1 } },
      { name: "select", option: { select: { id: true } } },
      { name: "omit", option: { omit: { label: true } } },
    ];
    try {
      for (const refusal of refusals) {
        const scalar = {
          where: { id: 10 },
          data: { label: { set: `scalar-${refusal.name}` } },
          ...refusal.option,
        };
        const relation = {
          where: { id: 10 },
          data: {
            children: { create: { label: `relation-${refusal.name}` } },
          },
          ...refusal.option,
        };
        await expect(
          prepareCandidateBatch(
            candidate,
            "packageParent",
            "updateMany",
            scalar
          )
        ).rejects.toBeInstanceOf(UnsupportedOperationError);
        await expect(
          candidate.execute("packageParent", "updateMany", scalar)
        ).rejects.toBeInstanceOf(UnsupportedOperationError);
        await expect(
          prepareCandidateBatch(
            candidate,
            "packageParent",
            "updateMany",
            relation
          )
        ).rejects.toBeInstanceOf(UnsupportedOperationError);
        await expect(
          candidate.execute("packageParent", "updateMany", relation)
        ).rejects.toBeInstanceOf(UnsupportedOperationError);
        assert.equal(
          driver.statements.length,
          0,
          `${refusal.name} must refuse before capture or mutation`
        );
      }
      assert.deepEqual(
        database
          .prepare("SELECT id, label FROM g3p03_package_parents ORDER BY id")
          .all(),
        [{ id: 10, label: "existing" }]
      );
      assert.deepEqual(
        database.prepare("SELECT * FROM g3p03_package_children").all(),
        []
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});
