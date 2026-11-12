import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { sql } from "@sql";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import Database from "better-sqlite3";
import { describe, it, vi } from "vitest";

const LEFT_COMPARISON =
  /"left_source"\."left_value"\s*>\s*"left_source"\."right_value"/;
const RIGHT_COMPARISON =
  /"right_source"\."left_value"\s*>\s*"right_source"\."right_value"/;
const RIGHT_ALIAS = /"right_source"/;
const LEFT_ALIAS = /"left_source"/;
const COLUMN_GREATER = /"([^"]+)"\."left_value"\s*>\s*"\1"\."right_value"/;
const COLUMN_EQUAL = /"([^"]+)"\."left_value"\s*=\s*"\1"\."right_value"/;
const FOREIGN_COLUMN =
  /Field reference 'other\.right' cannot be used while filtering 'row': a field reference may only compare columns of the same model\./;
function selectorSchema() {
  const tenant = s
    .model({
      id: s.string().id(),
      rows: s.toMany(() => row),
    })
    .map("post_g3_selector_tenants");
  const row = s
    .model({
      id: s.int().id(),
      tenantId: s.string().map("tenant_id"),
      left: s.int().map("left_value"),
      right: s.int().map("right_value"),
      tenant: s
        .toOne(() => tenant)
        .fields("tenantId")
        .references("id"),
    })
    .unique(["tenantId", "left"], { name: "tenant_left" })
    .map("post_g3_selector_rows");
  const other = s
    .model({
      id: s.int().id(),
      right: s.int().map("right_value"),
    })
    .map("post_g3_selector_others");
  return { tenant, row, other };
}

class SelectorRecordingSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (failure) {
    return failure;
  }
  throw new Error("Expected selector preparation to fail");
}

describe("post-G3 selector preparation", () => {
  it("preserves empty-filter semantics and internal selection guards", () => {
    const schema = selectorSchema();
    const database = new Database(":memory:");
    try {
      database.exec(
        "CREATE TABLE post_g3_selector_rows (id INTEGER, tenant_id TEXT, left_value INTEGER, right_value INTEGER);" +
          "INSERT INTO post_g3_selector_rows VALUES (1, 't1', 2, 3), (2, 't1', 4, 5), (3, 't2', 6, 7)"
      );
      const queries = new SqlQueries(
        new EngineSchema(schema),
        new SQLiteAdapter()
      );
      for (const { where, expected } of [
        { where: undefined, expected: [1, 2, 3] },
        { where: {}, expected: [1, 2, 3] },
        { where: { AND: [] }, expected: [1, 2, 3] },
        { where: { OR: [] }, expected: [] },
        { where: { NOT: { id: 2 } }, expected: [1, 3] },
      ]) {
        const query = queries.select(schema.row, {
          where,
          select: { id: true },
          orderBy: { id: "asc" },
        });
        assert.deepEqual(
          database
            .prepare(query.sql.toStatement())
            .pluck()
            .all(...query.sql.values),
          expected
        );
      }
      for (const controls of [
        { identity: { id: 2 } },
        { condition: sql`id = ${2}` },
        { identity: { id: 2 }, condition: sql`id <> ${1}` },
      ]) {
        const query = queries.select(
          schema.row,
          { select: { id: true }, orderBy: { id: "asc" } },
          undefined,
          controls
        );
        assert.deepEqual(
          database
            .prepare(query.sql.toStatement())
            .pluck()
            .all(...query.sql.values),
          [2]
        );
      }
    } finally {
      database.close();
    }
  });

  it("keeps SQL and parameters when reads omit write dependency facts", () => {
    const schema = selectorSchema();
    const refs = createModelFieldRefs("row", schema.row);
    for (const unique of [false, true]) {
      for (const where of [
        { id: 1 },
        { tenant_left: { tenantId: "t1", left: 2 } },
        {
          AND: [{ left: { gte: 2 } }, { right: { equals: refs.left } }],
          OR: [{ tenant: { is: { id: "t1" } } }, { NOT: { left: 3 } }],
        },
      ]) {
        const full = new SqlQueries(
          new EngineSchema(schema),
          new SQLiteAdapter()
        );
        const read = new SqlQueries(
          new EngineSchema(schema),
          new SQLiteAdapter()
        );
        const tracked = full.prepareSelector(schema.row, where, unique);
        const untracked = read.prepareSelector(
          schema.row,
          where,
          unique,
          false
        );
        assert.equal(Object.hasOwn(untracked, "facts"), false);
        assert.equal(Object.hasOwn(untracked, "uniqueValues"), false);
        const before = full.lowerSelector(tracked, "r");
        const after = read.lowerSelector(untracked, "r");
        assert.equal(after?.toStatement(), before?.toStatement());
        assert.deepEqual(after?.values, before?.values);
      }
    }
  });

  it("keeps every selector fact scope mutable and isolated", () => {
    const schema = selectorSchema();
    const queries = new SqlQueries(
      new EngineSchema(schema),
      new SQLiteAdapter()
    );
    const prepared = queries.prepareSelector(schema.row, { id: 1 });
    const identity = queries.identitySelector(schema.row, { id: 1 });
    const excluded = queries.excludeIdentities(schema.row, [{ id: 1 }]);
    const included = queries.includeIdentities(schema.row, [{ id: 1 }]);
    const conjoined = queries.andSelectors(schema.row, [prepared, included]);
    const scopes = [prepared, identity, excluded, included, conjoined];

    for (const [index, selector] of scopes.entries()) {
      for (const other of scopes.slice(index + 1)) {
        assert.notEqual(selector.facts.fields, other.facts.fields);
        assert.notEqual(selector.facts.equals, other.facts.equals);
        assert.notEqual(selector.facts.keys, other.facts.keys);
        assert.notEqual(selector.facts.reads, other.facts.reads);
      }
    }

    prepared.facts.fields.add("leaked");
    assert.equal(identity.facts.fields.has("leaked"), false);

    const firstRelation = queries.prepareSelector(schema.row, {
      tenant: { is: { id: "t1" } },
    }).facts.reads[0];
    const secondRelation = queries.prepareSelector(schema.row, {
      tenant: { is: { id: "t1" } },
    }).facts.reads[0];
    assert(firstRelation);
    assert(secondRelation);
    assert.notEqual(firstRelation.fields, secondRelation.fields);
    assert.notEqual(firstRelation.equals, secondRelation.equals);
    firstRelation.fields.add("leaked");
    assert.equal(secondRelation.fields.has("leaked"), false);
  });

  it("prepares mixed compound and relation facts without SQL or alias allocation", () => {
    const schema = selectorSchema();
    const adapter = new SQLiteAdapter();
    const queries = new SqlQueries(new EngineSchema(schema), adapter);
    const refs = createModelFieldRefs("row", schema.row);
    const column = vi.spyOn(adapter.identifiers, "column");
    const conjunction = vi.spyOn(adapter.operators, "and");
    const equality = vi.spyOn(adapter.operators, "eq");
    const comparison = vi.spyOn(adapter.operators, "gt");
    const existence = vi.spyOn(adapter.subqueries, "existsCheck");

    assert.equal(queries.alias(), "q0");
    const prepared = queries.prepareSelector(schema.row, {
      tenant_left: {
        tenantId: "t1",
        left: { gt: refs.right },
      },
      tenant: { is: { id: "t1" } },
    });
    const exactCompound = queries.prepareSelector(schema.row, {
      tenant_left: { tenantId: "t1", left: 5 },
    });

    assert.equal(column.mock.calls.length, 0);
    assert.equal(conjunction.mock.calls.length, 0);
    assert.equal(equality.mock.calls.length, 0);
    assert.equal(comparison.mock.calls.length, 0);
    assert.equal(existence.mock.calls.length, 0);
    assert.equal(queries.alias(), "q1");
    assert.equal(queries.selectorFacts(prepared), prepared.facts);
    assert.equal(prepared.uniqueKey, undefined);
    assert.deepEqual(exactCompound.uniqueKey, {
      kind: "compoundUnique",
      name: "tenant_left",
      fields: ["tenantId", "left"],
    });
    assert.deepEqual([...prepared.facts.fields], ["tenantId", "left"]);
    assert.deepEqual([...prepared.facts.equals], [["tenantId", "t1"]]);
    assert.equal(prepared.facts.exact, false);
    assert.equal(prepared.facts.reads.length, 1);
    const relationRead = prepared.facts.reads[0];
    assert(relationRead);
    assert.equal(relationRead.model, schema.tenant);
    assert.equal(relationRead.path.length, 1);
    assert.deepEqual([...relationRead.fields], ["id"]);
    assert.deepEqual([...relationRead.equals], [["id", "t1"]]);
    assert.equal(relationRead.exact, true);

    const left = queries.lowerSelector(prepared, "left_source");
    const right = queries.lowerSelector(prepared, "right_source");
    assert(left);
    assert(right);
    const leftSql = left.toStatement("?");
    const rightSql = right.toStatement("?");
    assert.match(leftSql, LEFT_COMPARISON);
    assert.match(rightSql, RIGHT_COMPARISON);
    assert.doesNotMatch(leftSql, RIGHT_ALIAS);
    assert.doesNotMatch(rightSql, LEFT_ALIAS);
    assert(column.mock.calls.length > 0);
    assert(conjunction.mock.calls.length > 0);
    assert(comparison.mock.calls.length > 0);
    assert(existence.mock.calls.length > 0);
  });

  it("executes admitted mapped-int FieldRef equality and comparison predicates", async () => {
    const schema = selectorSchema();
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE post_g3_selector_tenants(
        id TEXT PRIMARY KEY
      );
      CREATE TABLE post_g3_selector_rows(
        id INTEGER PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES post_g3_selector_tenants(id),
        left_value INTEGER NOT NULL,
        right_value INTEGER NOT NULL,
        UNIQUE(tenant_id, left_value)
      );
      CREATE TABLE post_g3_selector_others(
        id INTEGER PRIMARY KEY,
        right_value INTEGER NOT NULL
      );
      INSERT INTO post_g3_selector_tenants(id) VALUES ('t1');
      INSERT INTO post_g3_selector_rows(id, tenant_id, left_value, right_value)
      VALUES (1, 't1', 5, 3), (2, 't1', 4, 4), (3, 't1', 2, 6);
    `);
    const driver = new SelectorRecordingSQLiteDriver({ client: database });
    const candidate = createTestCommandEngine({ schema, driver });
    const refs = createModelFieldRefs("row", schema.row);

    try {
      assert.deepEqual(
        await candidate.execute("row", "findMany", {
          where: { left: { gt: refs.right } },
          select: { id: true },
        }),
        [{ id: 1 }]
      );
      assert.deepEqual(
        await candidate.execute("row", "findMany", {
          where: { left: { equals: refs.right } },
          select: { id: true },
        }),
        [{ id: 2 }]
      );
      assert.equal(driver.statements.length, 2);
      assert.match(driver.statements[0] ?? "", COLUMN_GREATER);
      assert.match(driver.statements[1] ?? "", COLUMN_EQUAL);
    } finally {
      await driver.disconnect();
      database.close();
    }
  });

  it("refuses a cross-model FieldRef before provider execution", async () => {
    const schema = selectorSchema();
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE post_g3_selector_rows(
        id INTEGER PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        left_value INTEGER NOT NULL,
        right_value INTEGER NOT NULL
      );
    `);
    const driver = new SelectorRecordingSQLiteDriver({ client: database });
    const candidate = createTestCommandEngine({ schema, driver });
    const otherRefs = createModelFieldRefs("other", schema.other);

    try {
      const failure = await captureFailure(() =>
        candidate.execute("row", "findMany", {
          where: { left: { equals: otherRefs.right } },
          select: { id: true },
        })
      );

      assert(failure instanceof QueryEngineError);
      assert.match(failure.message, FOREIGN_COLUMN);
      assert.equal(driver.statements.length, 0);
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});
