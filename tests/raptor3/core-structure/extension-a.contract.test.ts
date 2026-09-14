import assert from "node:assert/strict";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  QueryEngineError,
  TransactionError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { createClient } from "@client/client";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { it } from "vitest";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

class SelectionSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, parameters, context });
    return super.execute<T>(client, statement, parameters);
  }
}

class SelectionBatchSQLiteDriver extends SelectionSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

class MissingCreateManyRowDriver extends SQLite3Driver {
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, statement, parameters);
    if (
      context?.operation === "createMany" &&
      /^SELECT\b/i.test(statement.trim()) &&
      response.rows.length === 2
    ) {
      return { ...response, rows: response.rows.slice(1) };
    }
    return response;
  }
}

function selfNodeSchema() {
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("selectionTree"),
      children: s.toMany(() => node).name("selectionTree"),
    })
    .map("cs01_selection_nodes");
  return { node };
}

async function selfNodeWorld(batch = false) {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = batch
    ? new SelectionBatchSQLiteDriver({ client: database })
    : new SelectionSQLiteDriver({ client: database });
  const schema = selfNodeSchema();
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  driver.statements.length = 0;
  return { client, database, driver, schema };
}

it("CS-01 A returns omitted-key rows only after every relation-series member", async () => {
  const world = await selfNodeWorld();
  try {
    world.database.exec(`
      INSERT INTO cs01_selection_nodes VALUES(2,'parent',NULL);
      INSERT INTO cs01_selection_nodes VALUES(1,'child',2);
    `);

    const rows = await createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    }).execute("node", "updateMany", {
      where: { id: { in: [1, 2] } },
      data: {
        label: "seen",
        children: { updateMany: { where: {}, data: { label: "touched" } } },
      },
      select: { label: true },
    });

    assert.deepEqual(rows, [{ label: "touched" }, { label: "seen" }]);
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});

it("CS-01 A reads compound final keys while keeping injected keys private", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  let childId = 0;
  const parent = s
    .model({
      tenant: s.string(),
      serial: s.int(),
      label: s.string(),
      children: s.toMany(() => child),
    })
    .id(["tenant", "serial"])
    .map("cs01_selection_compound_parents");
  const child = s
    .model({
      id: s
        .int()
        .id()
        .default(() => ++childId),
      parentTenant: s.string(),
      parentSerial: s.int(),
      parent: s
        .toOne(() => parent)
        .fields("parentTenant", "parentSerial")
        .references("tenant", "serial"),
    })
    .map("cs01_selection_compound_children");
  const schema = { parent, child };
  const driver = new SelectionSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  try {
    database.exec(`
      INSERT INTO cs01_selection_compound_parents VALUES('t',1,'one');
      INSERT INTO cs01_selection_compound_parents VALUES('t',2,'two');
    `);
    driver.statements.length = 0;

    const rows = await createCommandEngine({ schema, driver }).execute(
      "parent",
      "updateMany",
      {
        where: { tenant: "t" },
        data: {
          serial: { increment: 10 },
          children: { create: {} },
        },
        select: { label: true },
      }
    );

    assert.deepEqual(rows, [{ label: "one" }, { label: "two" }]);
    assert.deepEqual(
      database
        .prepare(
          "SELECT tenant,serial,label FROM cs01_selection_compound_parents ORDER BY serial"
        )
        .all(),
      [
        { tenant: "t", serial: 11, label: "one" },
        { tenant: "t", serial: 12, label: "two" },
      ]
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT parentTenant,parentSerial FROM cs01_selection_compound_children ORDER BY parentSerial"
        )
        .all(),
      [
        { parentTenant: "t", parentSerial: 11 },
        { parentTenant: "t", parentSerial: 12 },
      ]
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
});

async function runMissingFinalRow(batch: boolean): Promise<void> {
  const world = await selfNodeWorld(batch);
  try {
    world.database.exec(`
      INSERT INTO cs01_selection_nodes VALUES(2,'parent',NULL);
      INSERT INTO cs01_selection_nodes VALUES(1,'child',2);
    `);
    world.driver.statements.length = 0;

    let failure: unknown;
    try {
      await createCommandEngine({
        schema: world.schema,
        driver: world.driver,
      }).execute("node", "updateMany", {
        where: { id: { in: [1, 2] } },
        data: { label: "changed", children: { deleteMany: {} } },
        select: { id: true, label: true },
      });
    } catch (caught) {
      failure = caught;
    }

    assert(failure instanceof TransactionError);
    assert.match(
      failure.message,
      /updateMany with 'select' could not read back one of the updated rows/
    );
    if (batch) {
      assert.deepEqual(failure.meta.recordSeriesProgress, {
        atomicity: "segment",
        phase: "result",
        committedSegments: 3,
        committedWriteMembers: 3,
        completedMembers: 3,
      });
      assert.deepEqual(
        world.database
          .prepare(
            "SELECT id,label,parentId FROM cs01_selection_nodes ORDER BY id"
          )
          .all(),
        [{ id: 2, label: "changed", parentId: null }]
      );
    } else {
      assert.equal(failure.meta.recordSeriesProgress, undefined);
      assert.deepEqual(
        world.database
          .prepare(
            "SELECT id,label,parentId FROM cs01_selection_nodes ORDER BY id"
          )
          .all(),
        [
          { id: 1, label: "child", parentId: 2 },
          { id: 2, label: "parent", parentId: null },
        ]
      );
    }
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
}

it("CS-01 A refuses a missing terminal row and rolls back interactively", async () => {
  await runMissingFinalRow(false);
});

it("CS-01 A reports acknowledged member progress when a terminal row is missing", async () => {
  await runMissingFinalRow(true);
});

it("CS-01 A preserves the createMany terminal underflow error contract", async () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = new MissingCreateManyRowDriver({ client: database });
  const schema = selfNodeSchema();
  const client = createClient({ schema, driver });
  try {
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);

    let failure: unknown;
    try {
      await createCommandEngine({ schema, driver }).execute(
        "node",
        "createMany",
        {
          data: [
            {
              id: 1,
              label: "one",
              children: { create: { id: 11, label: "child-one" } },
            },
            {
              id: 2,
              label: "two",
              children: { create: { id: 12, label: "child-two" } },
            },
          ],
          select: { id: true },
        }
      );
    } catch (caught) {
      failure = caught;
    }

    assert(failure instanceof QueryEngineError);
    assert.equal(failure instanceof TransactionError, false);
    assert.match(
      failure.message,
      /createMany with 'select' could not read back one of the created rows/
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
});

it("CS-01 A does not widen scalar returning or projection capabilities", async () => {
  const world = await selfNodeWorld();
  try {
    world.database.exec(
      "INSERT INTO cs01_selection_nodes VALUES(1,'original',NULL);"
    );
    const candidate = createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    });
    const attempts = [
      {
        args: {
          where: { id: 1 },
          data: { label: "scalar" },
          select: { id: true },
        },
        error: UnsupportedOperationError,
      },
      {
        args: {
          where: { id: 1 },
          data: { children: { create: { id: 2, label: "child" } } },
          select: { children: true },
        },
        error: ValidationError,
      },
      {
        args: {
          where: { id: 1 },
          data: { children: { create: { id: 2, label: "child" } } },
          omit: { label: true },
        },
        error: UnsupportedOperationError,
      },
      {
        args: {
          where: { id: 1 },
          data: { children: { create: { id: 2, label: "child" } } },
          include: { children: true },
        },
        error: ValidationError,
      },
    ] as const;

    for (const attempt of attempts) {
      await assert.rejects(
        candidate.execute("node", "updateMany", attempt.args),
        (failure) => failure instanceof attempt.error
      );
    }
    assert.equal(world.driver.statements.length, 0);
    assert.deepEqual(
      world.database
        .prepare("SELECT id,label,parentId FROM cs01_selection_nodes")
        .get(),
      { id: 1, label: "original", parentId: null }
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});
