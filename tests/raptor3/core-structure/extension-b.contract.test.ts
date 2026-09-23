import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { ValidationError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { it } from "vitest";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

class LimitSQLiteDriver extends SQLite3Driver {
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

function scalarSchema() {
  const entry = s
    .model({
      id: s.int().id(),
      group: s.string(),
      value: s.int(),
    })
    .map("cs01_limit_entries");
  return { entry };
}

async function scalarWorld() {
  const database = new Database(":memory:");
  const driver = new LimitSQLiteDriver({ client: database });
  const schema = scalarSchema();
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  database.exec(`
    INSERT INTO cs01_limit_entries VALUES(1,'selected',1);
    INSERT INTO cs01_limit_entries VALUES(2,'selected',2);
    INSERT INTO cs01_limit_entries VALUES(3,'selected',3);
  `);
  driver.statements.length = 0;
  return { client, database, driver, schema };
}

function writes(
  statements: readonly StatementObservation[],
  operation: "UPDATE" | "DELETE"
) {
  return statements.filter(({ sql }) =>
    new RegExp(`^${operation}\\b`, "i").test(sql.trim())
  );
}

it("CS-01 B applies a scalar updateMany limit in one set statement", async () => {
  const world = await scalarWorld();
  try {
    const result = await createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    }).execute("entry", "updateMany", {
      where: { group: "selected" },
      data: { value: { set: 9 } },
      limit: 2,
    });

    assert.deepEqual(result, { count: 2 });
    assert.equal(writes(world.driver.statements, "UPDATE").length, 1);
    assert.equal(
      world.driver.statements.some(({ sql }) => /^SELECT\b/i.test(sql.trim())),
      false
    );
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT value,COUNT(*) count FROM cs01_limit_entries GROUP BY value ORDER BY value"
        )
        .all(),
      [
        { value: 3, count: 1 },
        { value: 9, count: 2 },
      ]
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});

it("CS-01 B applies a scalar deleteMany limit in one set statement", async () => {
  const world = await scalarWorld();
  try {
    const result = await createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    }).execute("entry", "deleteMany", {
      where: { group: "selected" },
      limit: 2,
    });

    assert.deepEqual(result, { count: 2 });
    assert.equal(writes(world.driver.statements, "DELETE").length, 1);
    assert.equal(
      world.driver.statements.some(({ sql }) => /^SELECT\b/i.test(sql.trim())),
      false
    );
    assert.deepEqual(
      world.database
        .prepare(
          'SELECT "group",COUNT(*) count FROM cs01_limit_entries GROUP BY "group"'
        )
        .all(),
      [{ group: "selected", count: 1 }]
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});

function relationSchema(nextChildId: () => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      children: s.toMany(() => child),
    })
    .map("cs01_limit_shelves");
  const child = s
    .model({
      id: s.string().id().default(nextChildId),
      shelfId: s.string(),
      label: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id"),
    })
    .map("cs01_limit_children");
  return { shelf, child };
}

async function relationWorld() {
  const admissions: string[] = [];
  const schema = relationSchema(() => {
    const id = `child-${admissions.length}`;
    admissions.push(id);
    return id;
  });
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = new LimitSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  database.exec(`
    INSERT INTO cs01_limit_shelves VALUES('s1','one');
    INSERT INTO cs01_limit_shelves VALUES('s2','two');
    INSERT INTO cs01_limit_shelves VALUES('s3','three');
  `);
  driver.statements.length = 0;
  return { admissions, client, database, driver, schema };
}

it("CS-01 B caps relation capture before admitting or executing members", async () => {
  const world = await relationWorld();
  try {
    const result = await createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    }).execute("shelf", "updateMany", {
      where: {},
      data: {
        label: "capped",
        children: { create: { label: "created" } },
      },
      limit: 2,
    });

    assert.deepEqual(result, { count: 2 });
    assert.deepEqual(world.admissions, ["child-0", "child-1", "child-2"]);
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT label,COUNT(*) count,COUNT(DISTINCT shelfId) parents FROM cs01_limit_children GROUP BY label"
        )
        .all(),
      [{ label: "created", count: 2, parents: 2 }]
    );
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT label,COUNT(*) count FROM cs01_limit_shelves GROUP BY label ORDER BY label"
        )
        .all(),
      [
        { label: "capped", count: 2 },
        { label: "three", count: 1 },
      ]
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});

it("CS-01 B validates limits and makes limit zero a true no-op", async () => {
  const world = await relationWorld();
  try {
    const engine = createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    });
    const operation = (limit: number) =>
      engine.execute("shelf", "updateMany", {
        where: {},
        data: {
          label: "forbidden",
          children: { create: { label: "forbidden" } },
        },
        limit,
      });

    await assert.rejects(operation(-1), ValidationError);
    await assert.rejects(operation(1.5), ValidationError);
    assert.equal(world.driver.statements.length, 0);

    world.admissions.length = 0;
    const result = await operation(0);
    assert.deepEqual(result, { count: 0 });
    assert.deepEqual(world.admissions, ["child-0"]);
    assert.equal(world.driver.statements.length, 0);
    assert.deepEqual(
      world.database
        .prepare("SELECT id,label FROM cs01_limit_shelves ORDER BY id")
        .all(),
      [
        { id: "s1", label: "one" },
        { id: "s2", label: "two" },
        { id: "s3", label: "three" },
      ]
    );
    assert.deepEqual(
      world.database.prepare("SELECT * FROM cs01_limit_children").all(),
      []
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});
