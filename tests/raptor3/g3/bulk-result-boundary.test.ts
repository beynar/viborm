import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it, vi } from "vitest";

class ObservedSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

class NonReturningSQLiteDriver extends ObservedSQLiteDriver {
  constructor(database: Database.Database) {
    super({ client: database });
    this.adapter.capabilities.supportsReturning = false;
  }
}

function boundarySchema() {
  const record = s
    .model({
      id: s.int().id(),
      code: s.string().unique(),
      secret: s.string(),
      score: s.int(),
    })
    .map("g3_bulk_result_records");
  const defaultOnly = s
    .model({ id: s.int().id().increment() })
    .map("g3_bulk_result_default_only");
  return { defaultOnly, record };
}

async function prepareWorld(nonReturning = false) {
  const schema = boundarySchema();
  const database = new Database(":memory:");
  const driver = nonReturning
    ? new NonReturningSQLiteDriver(database)
    : new ObservedSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  const candidate = createCommandEngine({ schema, driver });
  driver.statements.length = 0;
  return { candidate, client, database, driver };
}

describe("G3 scalar bulk result boundaries", () => {
  it("returns the admitted empty mode for every update/delete presentation", async () => {
    const world = await prepareWorld();
    world.database.exec(
      "INSERT INTO g3_bulk_result_records(id,code,secret,score) VALUES(1,'one','hidden',1)"
    );
    try {
      assert.deepEqual(
        await world.candidate.execute("record", "updateMany", {
          where: { id: 1 },
          data: { score: 2 },
          limit: 0,
          select: { id: true },
        }),
        []
      );
      assert.deepEqual(
        await world.candidate.execute("record", "updateMany", {
          where: { id: 1 },
          data: { score: 2 },
          limit: 0,
          omit: { secret: true },
        }),
        []
      );
      assert.deepEqual(
        await world.candidate.execute("record", "updateMany", {
          where: { id: 1 },
          data: { score: 2 },
          limit: 0,
        }),
        { count: 0 }
      );
      assert.deepEqual(
        await world.candidate.execute("record", "deleteMany", {
          where: { id: 1 },
          limit: 0,
          select: { id: true },
        }),
        []
      );
      assert.deepEqual(
        await world.candidate.execute("record", "deleteMany", {
          where: { id: 1 },
          limit: 0,
          omit: { secret: true },
        }),
        []
      );
      assert.deepEqual(
        await world.candidate.execute("record", "deleteMany", {
          where: { id: 1 },
          limit: 0,
        }),
        { count: 0 }
      );
      assert.deepEqual(world.driver.statements, []);
      assert.deepEqual(
        world.database
          .prepare("SELECT id,code,secret,score FROM g3_bulk_result_records")
          .all(),
        [{ id: 1, code: "one", secret: "hidden", score: 1 }]
      );
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });

  it("packages zero-limit result modes with an empty physical window", async () => {
    const world = await prepareWorld();
    try {
      const operations = [
        ["updateMany", { data: { score: 2 }, limit: 0 }],
        [
          "updateMany",
          { data: { score: 2 }, limit: 0, select: { id: true } },
        ],
        [
          "updateMany",
          { data: { score: 2 }, limit: 0, omit: { secret: true } },
        ],
        ["deleteMany", { limit: 0 }],
        ["deleteMany", { limit: 0, select: { id: true } }],
        ["deleteMany", { limit: 0, omit: { secret: true } }],
      ] as const;
      const expected = [{ count: 0 }, [], [], { count: 0 }, [], []];
      for (const [index, [operation, args]] of operations.entries()) {
        const prepared = await world.candidate.prepareBatch(
          "record",
          operation,
          args
        );
        assert.ok(prepared);
        assert.deepEqual(prepared.queries, []);
        assert.deepEqual(prepared.parseResult([]), expected[index]);
      }
      assert.deepEqual(world.driver.statements, []);
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });

  it("keeps non-returning selected update/delete on their captured row sets", async () => {
    const world = await prepareWorld(true);
    world.database.exec(`
      INSERT INTO g3_bulk_result_records(id,code,secret,score) VALUES
        (1,'one','hidden-one',1),
        (2,'two','hidden-two',2),
        (3,'three','hidden-three',3);
    `);
    try {
      assert.deepEqual(
        await world.candidate.execute("record", "updateMany", {
          where: { id: 1 },
          data: { score: { increment: 10 } },
          limit: 1,
          select: { id: true, score: true },
        }),
        [{ id: 1, score: 11 }]
      );
      assert.deepEqual(
        await world.candidate.execute("record", "deleteMany", {
          where: { id: 2 },
          limit: 1,
          omit: { secret: true },
        }),
        [{ id: 2, code: "two", score: 2 }]
      );
      assert.equal(
        world.driver.statements.filter((statement) =>
          /^UPDATE\b/i.test(statement.trim())
        ).length,
        1
      );
      assert.equal(
        world.driver.statements.filter((statement) =>
          /^DELETE\b/i.test(statement.trim())
        ).length,
        1
      );
      assert.deepEqual(
        world.database
          .prepare(
            "SELECT id,code,secret,score FROM g3_bulk_result_records ORDER BY id"
          )
          .all(),
        [
          { id: 1, code: "one", secret: "hidden-one", score: 11 },
          { id: 3, code: "three", secret: "hidden-three", score: 3 },
        ]
      );
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });

  it("does not build discarded RETURNING work before fallback or refusal", async () => {
    const world = await prepareWorld(true);
    const returning = vi.spyOn(world.driver.adapter.mutations, "returning");
    try {
      await assert.rejects(
        world.candidate.execute("defaultOnly", "createMany", {
          data: [{}],
          skipDuplicates: true,
          select: { id: true },
        }),
        /cannot include a row with no explicit scalar values/
      );
      assert.equal(returning.mock.calls.length, 0);
      assert.deepEqual(world.driver.statements, []);

      assert.deepEqual(
        await world.candidate.execute("record", "createMany", {
          data: [
            { id: 1, code: "one", secret: "first", score: 1 },
            { id: 2, code: "two", secret: "second", score: 2 },
          ],
          select: { id: true, code: true },
        }),
        [
          { id: 1, code: "one" },
          { id: 2, code: "two" },
        ]
      );
      assert.equal(returning.mock.calls.length, 0);
      assert.deepEqual(
        world.database
          .prepare("SELECT id,code FROM g3_bulk_result_records ORDER BY id")
          .all(),
        [
          { id: 1, code: "one" },
          { id: 2, code: "two" },
        ]
      );
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });

  it("lowers one capped selector only at its aliased mutation boundary", async () => {
    const world = await prepareWorld();
    world.database.exec(`
      INSERT INTO g3_bulk_result_records(id,code,secret,score) VALUES
        (1,'one','first',1),
        (2,'two','second',2)
    `);
    const equals = vi.spyOn(world.driver.adapter.operators, "eq");
    try {
      assert.deepEqual(
        await world.candidate.execute("record", "deleteMany", {
          where: { id: 1 },
          limit: 1,
        }),
        { count: 1 }
      );
      assert.equal(equals.mock.calls.length, 1);
      assert.deepEqual(
        world.database
          .prepare("SELECT id,code FROM g3_bulk_result_records ORDER BY id")
          .all(),
        [{ id: 2, code: "two" }]
      );
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });
});
