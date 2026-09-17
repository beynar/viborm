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

/** The correlated child DELETE U6.2 compiles for a nested `deleteMany`. */
const CORRELATED_CHILD_DELETE =
  /^DELETE FROM "cs01_selection_nodes" WHERE \("cs01_selection_nodes"\."parentId" = \?/;
/** A read that addresses the children — the member capture U6.2 removed. */
const CHILD_MEMBER_READ = /^SELECT\b[\s\S]*WHERE[\s\S]*"parentId"/;

async function runMissingFinalRow(batch: boolean): Promise<string[]> {
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
      // U6.2 (parity, `raptor3-parity-plan.md`): a nested `deleteMany` whose
      // data carries no relation write is ONE correlated statement at its own
      // position in its parent member's body, not a captured series with
      // members of its own. The operation's members are therefore the two
      // root rows — it was three while the nested set mutation was a member —
      // and the caller pins the plan that makes the count what it is.
      assert.deepEqual(failure.meta.recordSeriesProgress, {
        atomicity: "segment",
        phase: "result",
        committedSegments: 2,
        committedWriteMembers: 2,
        completedMembers: 2,
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
    return world.driver.statements.map(({ sql }) => sql);
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
}

it("CS-01 A refuses a missing terminal row and rolls back interactively", async () => {
  await runMissingFinalRow(false);
});

it("CS-01 A reports acknowledged member progress when a terminal row is missing", async () => {
  const dispatched = await runMissingFinalRow(true);
  // The plan behind the two members: one correlated DELETE per root member,
  // and no read of the children to delete them (U6.2).
  const deletes = dispatched.filter((sql) => sql.startsWith("DELETE"));
  assert.equal(deletes.length, 2);
  for (const statement of deletes)
    assert.match(statement, CORRELATED_CHILD_DELETE);
  assert.equal(
    dispatched.some((sql) => CHILD_MEMBER_READ.test(sql)),
    false,
    "the nested deleteMany reads no member to delete it"
  );
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

it("CS-01 A returns selected scalar updates but does not widen relation projections", async () => {
  const world = await selfNodeWorld();
  try {
    world.database.exec(
      "INSERT INTO cs01_selection_nodes VALUES(1,'original',NULL);"
    );
    const candidate = createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    });
    assert.deepEqual(
      await candidate.execute("node", "updateMany", {
        where: { id: 1 },
        data: { label: "scalar" },
        select: { id: true },
      }),
      [{ id: 1 }]
    );
    const statementsAfterScalar = world.driver.statements.length;
    assert(statementsAfterScalar > 0);
    const relationWrite = {
      where: { id: 1 },
      data: { children: { create: { id: 2, label: "child" } } },
    };
    const attempts = [
      {
        name: "selected relation",
        args: {
          ...relationWrite,
          select: { children: true },
        },
        error: ValidationError,
      },
      {
        name: "included relation",
        args: {
          ...relationWrite,
          include: { children: true },
        },
        error: ValidationError,
      },
    ] as const;

    for (const attempt of attempts) {
      await assert.rejects(
        candidate.execute("node", "updateMany", attempt.args),
        (failure) => failure instanceof attempt.error,
        attempt.name
      );
    }
    assert.equal(world.driver.statements.length, statementsAfterScalar);
    assert.deepEqual(
      await candidate.execute("node", "updateMany", {
        ...relationWrite,
        omit: { label: true },
      }),
      [{ id: 1, parentId: null }]
    );
    assert(world.driver.statements.length > statementsAfterScalar);
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT id,label,parentId FROM cs01_selection_nodes ORDER BY id"
        )
        .all(),
      [
        { id: 1, label: "scalar", parentId: null },
        { id: 2, label: "child", parentId: 1 },
      ]
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});
