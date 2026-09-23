import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it } from "vitest";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

class BulkWitnessSQLiteDriver extends SQLite3Driver {
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

function createBulkSchema(onDefault: () => string) {
  const record = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      label: s.string().default(onDefault),
      secret: s.string().default("private"),
      score: s.int().default(0),
    })
    .map("g3_bulk_records");
  const defaultOnly = s
    .model({ id: s.int().id().increment() })
    .map("g3_bulk_default_only");
  return { record, defaultOnly };
}

function createBulkClient(
  schema: ReturnType<typeof createBulkSchema>,
  driver: BulkWitnessSQLiteDriver
) {
  return createClient({ schema, driver });
}

describe("G3 C08 scalar bulk semantics", () => {
  let database: Database.Database;
  let driver: BulkWitnessSQLiteDriver;
  let client: ReturnType<typeof createBulkClient>;
  let candidate: ReturnType<typeof createCommandEngine>;
  let admissions: number;

  beforeEach(async () => {
    admissions = 0;
    const schema = createBulkSchema(() => `default-${++admissions}`);
    database = new Database(":memory:");
    driver = new BulkWitnessSQLiteDriver({ client: database });
    client = createBulkClient(schema, driver);
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);
    candidate = createCommandEngine({ schema, driver });
    driver.statements.length = 0;
  });

  afterEach(async () => {
    await client.$disconnect();
    database.close();
  });

  function mutations(kind: "INSERT" | "UPDATE" | "DELETE") {
    return driver.statements.filter(({ sql }) =>
      new RegExp(`^${kind}\\b`, "i").test(sql.trim())
    );
  }

  it("groups contiguous scalar row shapes and evaluates each default once", async () => {
    const outcome = await candidate.execute("record", "createMany", {
      data: [
        { id: 100, code: "a" },
        { id: 101, code: "b", label: "explicit-b" },
        { code: "c" },
        { code: "d", label: "explicit-d" },
        { id: 200, code: "e" },
      ],
    });

    assert.deepEqual(outcome, { count: 5 });
    assert.equal(admissions, 3);
    // The shipped fold emits one set statement per contiguous physical row
    // shape. These inputs have explicit-id, generated-id, explicit-id runs.
    assert.equal(mutations("INSERT").length, 3);
    assert.equal(
      driver.statements.some(({ sql }) => /^SELECT\b/i.test(sql.trim())),
      false
    );
    assert.deepEqual(
      database
        .prepare("SELECT code,label FROM g3_bulk_records ORDER BY id")
        .all(),
      [
        { code: "a", label: "default-1" },
        { code: "b", label: "explicit-b" },
        { code: "c", label: "default-2" },
        { code: "d", label: "explicit-d" },
        { code: "e", label: "default-3" },
      ]
    );
  });

  it("returns generated identities for default-only rows in input order", async () => {
    const outcome = await candidate.execute("defaultOnly", "createMany", {
      data: [{}, {}],
      select: { id: true },
    });

    assert.ok(Array.isArray(outcome));
    assert.equal(outcome.length, 2);
    const first = outcome[0];
    const second = outcome[1];
    assert.ok(first && typeof first === "object" && "id" in first);
    assert.ok(second && typeof second === "object" && "id" in second);
    assert.equal(typeof first.id, "number");
    assert.equal(typeof second.id, "number");
    assert.notEqual(first.id, second.id);
    assert.deepEqual(
      [first.id, second.id],
      database
        .prepare("SELECT id FROM g3_bulk_default_only ORDER BY id")
        .all()
        .map((row) => {
          assert(row && typeof row === "object" && "id" in row);
          return row.id;
        })
    );
  });

  it("skips only conflicting scalar roots and counts the healthy suffix", async () => {
    database.exec(
      "INSERT INTO g3_bulk_records(id,code,label,secret,score) VALUES(1,'taken','existing','kept',1)"
    );

    const outcome = await candidate.execute("record", "createMany", {
      data: [
        { id: 2, code: "taken", label: "duplicate" },
        { id: 3, code: "fresh", label: "inserted" },
      ],
      skipDuplicates: true,
    });

    assert.deepEqual(outcome, { count: 1 });
    assert.deepEqual(
      database
        .prepare(
          "SELECT id,code,label,secret,score FROM g3_bulk_records ORDER BY id"
        )
        .all(),
      [
        {
          id: 1,
          code: "taken",
          label: "existing",
          secret: "kept",
          score: 1,
        },
        {
          id: 3,
          code: "fresh",
          label: "inserted",
          secret: "private",
          score: 0,
        },
      ]
    );
  });

  it("returns createMany omit rows in input order", async () => {
    const outcome = await candidate.execute("record", "createMany", {
      data: [
        { id: 5, code: "five", label: "first", secret: "hidden-a" },
        { id: 4, code: "four", label: "second", secret: "hidden-b" },
      ],
      omit: { secret: true },
    });

    assert.deepEqual(outcome, [
      { id: 5, code: "five", label: "first", score: 0 },
      { id: 4, code: "four", label: "second", score: 0 },
    ]);
  });

  it("keeps scalar updateMany select plus limit set-oriented", async () => {
    database.exec(`
      INSERT INTO g3_bulk_records(id,code,label,secret,score) VALUES
        (1,'a','one','s1',1),
        (2,'b','two','s2',2),
        (3,'c','three','s3',3);
    `);
    driver.statements.length = 0;

    const outcome = await candidate.execute("record", "updateMany", {
      where: { score: { lt: 4 } },
      data: { score: { increment: 10 } },
      limit: 2,
      select: { id: true, score: true },
    });

    assert.ok(Array.isArray(outcome));
    assert.equal(outcome.length, 2);
    const returnedRows: { id: number; score: number }[] = [];
    for (const row of outcome) {
      assert.ok(
        row && typeof row === "object" && "id" in row && "score" in row
      );
      assert.equal(typeof row.id, "number");
      assert.equal(typeof row.score, "number");
      assert.ok(row.score >= 11);
      returnedRows.push({ id: row.id, score: row.score });
    }
    assert.equal(mutations("UPDATE").length, 1);
    assert.equal(
      driver.statements.some(({ sql }) => /^SELECT\b/i.test(sql.trim())),
      false
    );
    const storedRows: { id: number; score: number }[] = [];
    for (const row of database
      .prepare("SELECT id,score FROM g3_bulk_records ORDER BY id")
      .all()) {
      assert(row && typeof row === "object" && "id" in row && "score" in row);
      const { id, score } = row;
      assert.ok(typeof id === "number");
      assert.ok(typeof score === "number");
      storedRows.push({ id, score });
    }
    const changedRows = storedRows.filter(({ score }) => score >= 11);
    assert.equal(changedRows.length, 2);
    assert.equal(storedRows.filter(({ score }) => score < 4).length, 1);
    assert.deepEqual(
      returnedRows.sort((left, right) => left.id - right.id),
      changedRows
    );
  });

  it("returns deleteMany omit rows from the pre-delete state", async () => {
    database.exec(`
      INSERT INTO g3_bulk_records(id,code,label,secret,score) VALUES
        (1,'a','one','hidden-a',1),
        (2,'b','two','hidden-b',2),
        (3,'c','three','hidden-c',10);
    `);
    driver.statements.length = 0;

    const outcome = await candidate.execute("record", "deleteMany", {
      where: { score: { lt: 5 } },
      omit: { secret: true },
    });

    assert.ok(Array.isArray(outcome));
    assert.deepEqual(
      [...outcome].sort((left, right) => {
        assert.ok(left && typeof left === "object" && "id" in left);
        assert.ok(right && typeof right === "object" && "id" in right);
        assert.equal(typeof left.id, "number");
        assert.equal(typeof right.id, "number");
        return left.id - right.id;
      }),
      [
        { id: 1, code: "a", label: "one", score: 1 },
        { id: 2, code: "b", label: "two", score: 2 },
      ]
    );
    assert.deepEqual(
      database.prepare("SELECT id,code FROM g3_bulk_records ORDER BY id").all(),
      [{ id: 3, code: "c" }]
    );
  });
});
