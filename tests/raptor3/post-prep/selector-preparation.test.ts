import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import Database from "better-sqlite3";
import { describe, it, vi } from "vitest";

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

function conditionalUpsertSchema() {
  const account = s
    .model({
      id: s.int().id(),
      email: s.string().unique(),
      count: s.int(),
    })
    .map("post_g3_selector_upserts");
  return { account };
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
  it("prepares mixed compound and relation facts without SQL or alias allocation", () => {
    const schema = selectorSchema();
    const adapter = new SQLiteAdapter();
    const queries = new Queries(new EngineSchema(schema), adapter);
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
    assert.match(
      leftSql,
      /"left_source"\."left_value"\s*>\s*"left_source"\."right_value"/
    );
    assert.match(
      rightSql,
      /"right_source"\."left_value"\s*>\s*"right_source"\."right_value"/
    );
    assert.doesNotMatch(leftSql, /"right_source"/);
    assert.doesNotMatch(rightSql, /"left_source"/);
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
    const candidate = createCommandEngine({ schema, driver });
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
      assert.match(
        driver.statements[0] ?? "",
        /"([^"]+)"\."left_value"\s*>\s*"\1"\."right_value"/
      );
      assert.match(
        driver.statements[1] ?? "",
        /"([^"]+)"\."left_value"\s*=\s*"\1"\."right_value"/
      );
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
    const candidate = createCommandEngine({ schema, driver });
    const otherRefs = createModelFieldRefs("other", schema.other);

    try {
      const failure = await captureFailure(() =>
        candidate.execute("row", "findMany", {
          where: { left: { equals: otherRefs.right } },
          select: { id: true },
        })
      );

      assert(failure instanceof QueryEngineError);
      assert.match(
        failure.message,
        /Field reference 'other\.right' cannot be used while filtering 'row': a field reference may only compare columns of the same model\./
      );
      assert.equal(driver.statements.length, 0);
    } finally {
      await driver.disconnect();
      database.close();
    }
  });

  it("reuses one upsert base selector across both prepared condition probes", async () => {
    const schema = conditionalUpsertSchema();
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE post_g3_selector_upserts(
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        count INTEGER NOT NULL
      );
      INSERT INTO post_g3_selector_upserts(id, email, count)
      VALUES (1, 'wanted', 10);
    `);
    const driver = new SelectorRecordingSQLiteDriver({ client: database });
    const candidate = createCommandEngine({ schema, driver });
    const preparation = vi.spyOn(Queries.prototype, "prepareSelector");
    const conjunction = vi.spyOn(Queries.prototype, "andSelectors");
    const lowering = vi.spyOn(Queries.prototype, "lowerSelector");

    try {
      assert.deepEqual(
        await candidate.execute("account", "upsert", {
          where: { email: "wanted" },
          targetWhere: { count: 10 },
          setWhere: { count: 10 },
          create: { id: 2, email: "wanted", count: 0 },
          update: { count: 15 },
          select: { id: true, email: true, count: true },
        }),
        { id: 1, email: "wanted", count: 15 }
      );

      assert.equal(preparation.mock.calls.length, 3);
      assert.deepEqual(preparation.mock.calls[0]?.[1], { email: "wanted" });
      assert.deepEqual(preparation.mock.calls[1]?.[1], {
        count: { equals: 10 },
      });
      assert.deepEqual(preparation.mock.calls[2]?.[1], {
        count: { equals: 10 },
      });
      const baseResult = preparation.mock.results[0];
      const targetResult = preparation.mock.results[1];
      const setResult = preparation.mock.results[2];
      assert(baseResult);
      assert(targetResult);
      assert(setResult);
      if (baseResult.type !== "return")
        assert.fail("base selector preparation did not return normally");
      if (targetResult.type !== "return")
        assert.fail("target condition preparation did not return normally");
      if (setResult.type !== "return")
        assert.fail("set condition preparation did not return normally");
      const base = baseResult.value;
      const target = targetResult.value;
      const set = setResult.value;

      // Three conjunctions, one per prepared meaning this shape needs: the two
      // condition probes, and — the repair prompt §1, the shared
      // FOUND-consumption rule — the ONE confirmation that re-takes the located
      // row under lock over EVERY matched condition. That third operand list is
      // the two probe selectors themselves, so the base is reused a third time
      // and nothing is prepared again (`preparation` is still 3 above).
      assert.equal(conjunction.mock.calls.length, 3);
      const targetOperands = conjunction.mock.calls[0]?.[1];
      const setOperands = conjunction.mock.calls[1]?.[1];
      assert(targetOperands);
      assert(setOperands);
      assert.equal(targetOperands.length, 2);
      assert.equal(targetOperands[0], base);
      assert.equal(targetOperands[1], target);
      assert.equal(setOperands.length, 2);
      assert.equal(setOperands[0], base);
      assert.equal(setOperands[1], set);
      const targetConjunctionResult = conjunction.mock.results[0];
      const setConjunctionResult = conjunction.mock.results[1];
      assert(targetConjunctionResult);
      assert(setConjunctionResult);
      if (targetConjunctionResult.type !== "return")
        assert.fail("target selector conjunction did not return normally");
      if (setConjunctionResult.type !== "return")
        assert.fail("set selector conjunction did not return normally");
      assert(
        lowering.mock.calls.some(
          ([selector]) => selector === targetConjunctionResult.value
        )
      );
      assert(
        lowering.mock.calls.some(
          ([selector]) => selector === setConjunctionResult.value
        )
      );
      const confirmationOperands = conjunction.mock.calls[2]?.[1];
      assert(confirmationOperands);
      assert.deepEqual(
        [...confirmationOperands],
        [targetConjunctionResult.value, setConjunctionResult.value]
      );
      const confirmationResult = conjunction.mock.results[2];
      assert(confirmationResult);
      if (confirmationResult.type !== "return")
        assert.fail("confirmation conjunction did not return normally");
      assert(
        lowering.mock.calls.some(
          ([selector]) => selector === confirmationResult.value
        )
      );

      // The locator probe, the two condition probes, ONE confirmation of the
      // located row carrying both matched conditions, the update arm's effect
      // and the terminal read (repair prompt §1: the confirmation is one
      // statement over every requirement the operation owns, not one statement
      // per requirement).
      assert.deepEqual(
        driver.statements.map((statement) => statement.match(/^\w+/)?.[0]),
        ["SELECT", "SELECT", "SELECT", "SELECT", "UPDATE", "SELECT"]
      );
      assert.deepEqual(
        database
          .prepare("SELECT id, email, count FROM post_g3_selector_upserts")
          .get(),
        { id: 1, email: "wanted", count: 15 }
      );
    } finally {
      preparation.mockRestore();
      conjunction.mockRestore();
      lowering.mockRestore();
      await driver.disconnect();
      database.close();
    }
  });
});
