import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { TransactionWriteOutcomes } from "@extensions/query";
import { buildAggregateInputWindow } from "@query-engine/operations/aggregate-input";
import { buildBulkLimitWhere } from "@query-engine/operations/bulk-limit";
import { buildCreateManyPlan } from "@query-engine/operations/create";
import { buildCursorCondition } from "@query-engine/operations/cursor-condition";
import {
  buildNormalizedOrderBy,
  normalizeCursorOrder,
} from "@query-engine/operations/cursor-order";
import { buildFind } from "@query-engine/operations/find-common";
import { buildFindPagination } from "@query-engine/operations/find-pagination";
import { buildFindUnique } from "@query-engine/operations/find-unique";
import { buildGroupBy } from "@query-engine/operations/groupby";
import { getGroupByFields } from "@query-engine/operations/groupby-fields";
import { buildHaving } from "@query-engine/operations/groupby-having";
import {
  assertCreateRefetchIdentity,
  assertPortablePrimaryKeyUpdateInput,
  databaseAssignedRowKeyFields,
  getCreatedRowWhere,
  getPrimaryKeyValuesFromRecord,
  getProvidedPrimaryKeyWhere,
  getUpdatedPrimaryKeyValue,
  getUpdatedPrimaryKeyValues,
  planNestedCreateIdentity,
} from "@query-engine/operations/mutation-identity";
import { compileMutationDependencyFold } from "@query-engine/operations/mutation-projection-fold";
import {
  attachPendingCacheExecution,
  isPendingOperation,
  PENDING_OPERATION_SYMBOL,
} from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { readTransactionOperation } from "@query-engine/transaction-operation";
import {
  ref,
  type WriteStep,
} from "@query-engine/write-engine/OperationFragment";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const account = s.model({
  id: s.int().id(),
  alternate: s.string().unique(),
  name: s.string(),
  active: s.boolean(),
  rank: s.int().nullable(),
  amount: s.decimal({ precision: 12, scale: 2 }),
  entries: s.toMany(() => entry),
});
const entry = s.model({
  id: s.int().id(),
  accountId: s.int(),
  account: s
    .toOne(() => account)
    .fields("accountId")
    .references("id"),
  title: s.string(),
});
const compound = s
  .model({
    tenant: s.string(),
    sequence: s.int(),
    enabled: s.boolean(),
  })
  .id(["tenant", "sequence"]);
const generated = s.model({
  id: s.int().increment().id(),
  label: s.string().default("generated"),
});
const bigintIdentity = s.model({ id: s.bigInt().id() });
const numberIdentity = s.model({ id: s.number().id() });

prepareSchema({
  account,
  entry,
  compound,
  generated,
  bigintIdentity,
  numberIdentity,
});

describe("query operation composition boundaries", () => {
  test("composes cursor, public filters, trusted predicates, projections, and distinct pagination", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const statement = buildFind(
      scope,
      {
        where: { active: { equals: true } },
        orderBy: { name: "asc" },
        cursor: { id: 7 },
        skip: 2,
        distinct: ["name"],
        select: { id: true, name: true },
        forUpdate: true,
      },
      {
        limit: 3,
        predicate: sql`${9} > ${3}`,
        additionalColumns: [sql`${11} AS "ordinal"`],
      }
    );
    const text = statement.toStatement("$n");

    expect(text).toContain("ROW_NUMBER()");
    expect(text).toContain("PARTITION BY");
    expect(text).toContain("_distinct_subquery");
    expect(text).toContain('AS "ordinal"');
    expect(text).toContain("ORDER BY");
    expect(text).toContain("LIMIT");
    expect(text).toContain("OFFSET");
    expect(text).toContain("AND");

    const locked = buildFind(
      scope,
      {
        where: { active: { equals: true } },
        select: { id: true },
        forUpdate: true,
      },
      {}
    );
    expect(locked.toStatement("$n")).toContain("FOR UPDATE");
  });

  test("builds a filtered cursor window and the empty projection used by count", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const filtered = buildAggregateInputWindow(
      scope,
      {
        where: { active: { equals: true } },
        orderBy: { name: "asc" },
        cursor: { id: 7 },
        take: -4,
        skip: 1,
      },
      ["name", "name", "amount"]
    );
    const countInput = buildAggregateInputWindow(scope, {}, []);

    expect(filtered.alias).toBe("aggregate_input");
    expect(filtered.from.toStatement("$n")).toContain("WHERE");
    expect(filtered.from.toStatement("$n")).toContain("ORDER BY");
    expect(filtered.from.toStatement("$n")).toContain("LIMIT");
    expect(filtered.from.toStatement("$n")).toContain("OFFSET");
    expect(countInput.from.toStatement("$n")).toContain('1 AS "_row"');
  });

  test("adds internal predicates and columns to a unique read", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const statement = buildFindUnique(
      scope,
      { where: { id: 7 }, select: { id: true } },
      {
        predicate: sql`${4} = ${4}`,
        additionalColumns: [sql`${1} AS "ordinal"`],
      }
    );
    const text = statement.toStatement("$n");

    expect(text).toContain('AS "ordinal"');
    expect(text).toContain("AND");
    expect(text).toContain("LIMIT 1");
  });

  test("caps a compound-key bulk mutation through its complete key tuple", () => {
    const scope = scopeFor(new PostgresAdapter(), compound);
    const predicate = sql`"compound"."enabled" = ${true}`;
    const limited = buildBulkLimitWhere(
      scope,
      predicate,
      { enabled: { equals: true } },
      3,
      predicate
    );
    const text = limited.where?.toStatement("$n");

    expect(limited.suffix).toBeUndefined();
    expect(text).toContain('("compound"."tenant", "compound"."sequence")');
    expect(text).toContain(" IN (SELECT ");
    expect(text).toContain("LIMIT");
  });

  test("reverses relation-order fallback without interpreting nested order keys", () => {
    const scope = scopeFor(new PostgresAdapter(), entry);
    const plan = buildFindPagination(
      scope,
      {
        orderBy: {
          account: {
            rank: { sort: "desc", nulls: "first" },
            entries: { _count: "asc" },
          },
        },
      },
      -2,
      scope.rootAlias
    );

    expect(plan.normalizedOrder).toBeUndefined();
    expect(plan.orderBy).toEqual({
      account: {
        rank: { sort: "asc", nulls: "last" },
        entries: { _count: "desc" },
      },
    });
  });

  test("renders nullable and non-null scalar order members through one normalized plan", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const order = normalizeCursorOrder(
      scope,
      [{ rank: { sort: "asc", nulls: "first" } }, { name: "desc" }],
      undefined,
      4,
      scope.rootAlias
    );
    if (!order) throw new Error("Expected normalized scalar ordering.");

    expect(buildNormalizedOrderBy(scope, order)?.toStatement("$n")).toContain(
      '"t0"."rank" ASC NULLS FIRST, "t0"."name" DESC'
    );
  });
});

describe("grouped aggregate operation boundaries", () => {
  test("combines logical groups and every aggregate expression with canonical filters", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const having = buildHaving(
      scope,
      {
        AND: [
          {
            amount: {
              _avg: { gte: "1.25" },
              _sum: { lte: "100.00" },
              _min: { equals: "1.00" },
              _max: { not: "9.00" },
            },
          },
          { id: { _count: { in: [1, 2], notIn: [3, 4] } } },
        ],
        OR: [{ id: { _sum: { gt: 1, lt: 20 } } }],
        NOT: [{ id: { _min: { lte: 0 } } }, { id: { _max: { gte: 10 } } }],
        name: { equals: "group-a" },
      },
      scope.rootAlias,
      ["name"]
    );
    if (!having) throw new Error("Expected a HAVING expression.");
    const text = having.toStatement("$n");

    expect(text).toContain("SUM");
    expect(text).toContain("MIN");
    expect(text).toContain("MAX");
    expect(text).toContain("COUNT");
    expect(text).toContain("div(");
    expect(text).not.toContain("AVG(");
    expect(text).toContain(" IN ");
    expect(text).toContain("NOT IN");
    expect(text).toContain("NOT");
  });

  test("keeps empty logical groups aligned with SQL truth values", () => {
    const scope = scopeFor(new PostgresAdapter(), account);

    expect(
      buildHaving(scope, { OR: [] }, scope.rootAlias, [])?.toStatement("$n")
    ).toBe("FALSE");
    expect(
      buildHaving(scope, { AND: [] }, scope.rootAlias, [])
    ).toBeUndefined();
    expect(
      buildHaving(scope, { NOT: [] }, scope.rootAlias, [])
    ).toBeUndefined();
  });

  test("supports direct aggregate operands, null predicates, and empty sets", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const direct = buildHaving(
      scope,
      {
        id: {
          _count: 2,
          _min: { equals: null },
          _max: { not: null },
          _sum: { in: [], notIn: [] },
        },
        name: "group-a",
      },
      scope.rootAlias,
      ["name"]
    );
    if (!direct) throw new Error("Expected direct HAVING predicates.");

    const text = direct.toStatement("$n");
    expect(text).toContain("COUNT");
    expect(text).toContain("IS NULL");
    expect(text).toContain("IS NOT NULL");
    expect(text).toContain("FALSE");
    expect(text).toContain("TRUE");
  });

  test("accepts the single-object AND and NOT forms", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const having = buildHaving(
      scope,
      {
        AND: { name: { equals: "group-a" } },
        NOT: { name: { equals: "group-b" } },
      },
      scope.rootAlias,
      ["name"]
    );

    expect(having?.toStatement("$n")).toContain("NOT");
  });

  test("normalizes a single group key and rejects duplicate result keys", () => {
    expect(getGroupByFields("name")).toEqual(["name"]);
    expect(() => getGroupByFields(["name", "name"])).toThrow(
      "does not allow duplicate fields"
    );
  });
});

describe("create and mutation identity boundaries", () => {
  test("returns generated default rows from one default-values statement", () => {
    const plan = buildCreateManyPlan(
      scopeFor(new PostgresAdapter(), generated),
      { data: [{}], select: { id: true, label: true } },
      true
    );

    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]?.inputIndexes).toEqual([0]);
    expect(plan.statements[0]?.sql.toStatement("$n")).toContain(
      "DEFAULT VALUES RETURNING"
    );
  });

  test("computes every portable numeric primary-key operation", () => {
    expect(
      getUpdatedPrimaryKeyValue(
        bigintIdentity,
        "id",
        5,
        { increment: "3" },
        "bigintIdentity"
      )
    ).toBe(8n);
    expect(
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        "12",
        { decrement: 2 },
        "numberIdentity"
      )
    ).toBe(10);
    expect(
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        3,
        { multiply: 2.5 },
        "numberIdentity"
      )
    ).toBe(7.5);
    expect(
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        9,
        { divide: 2 },
        "numberIdentity"
      )
    ).toBe(4.5);
    expect(
      getUpdatedPrimaryKeyValue(
        bigintIdentity,
        "id",
        "12",
        { decrement: 2 },
        "bigintIdentity"
      )
    ).toBe(10n);
    expect(
      getUpdatedPrimaryKeyValue(
        bigintIdentity,
        "id",
        3n,
        { multiply: 4n },
        "bigintIdentity"
      )
    ).toBe(12n);
    expect(
      getUpdatedPrimaryKeyValue(
        bigintIdentity,
        "id",
        9n,
        { divide: 2n },
        "bigintIdentity"
      )
    ).toBe(4n);
    expect(
      getUpdatedPrimaryKeyValue(account, "id", 9, { divide: 2 }, "account")
    ).toBe(4);
    expect(
      getUpdatedPrimaryKeyValue(numberIdentity, "id", 1, 7, "numberIdentity")
    ).toBe(7);
    expect(
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        4n,
        { increment: 1 },
        "numberIdentity"
      )
    ).toBe(5);
    expect(
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        1,
        { set: 8 },
        "numberIdentity"
      )
    ).toBe(8);
  });

  test("plans assigned, generated, and updated mutation identities", () => {
    expect(databaseAssignedRowKeyFields(generated, {})).toEqual(["id"]);
    expect(databaseAssignedRowKeyFields(generated, { id: 12 })).toEqual([]);
    expect(planNestedCreateIdentity(generated, {})).toEqual({
      identity: {},
      databaseAssigned: ["id"],
    });
    expect(planNestedCreateIdentity(account, { id: 7 })).toEqual({
      identity: { id: 7 },
      databaseAssigned: [],
    });
    expect(() => planNestedCreateIdentity(account, {})).toThrow(
      "requires primary key field 'id'"
    );

    const scope = scopeFor(new PostgresAdapter(), account);
    expect(
      getPrimaryKeyValuesFromRecord(account, { id: 4 }, "account")
    ).toEqual({ id: 4 });
    expect(
      getUpdatedPrimaryKeyValues(
        scope,
        { id: 4 },
        { id: { increment: 3 } },
        "account"
      )
    ).toEqual({ id: 7 });
    expect(getProvidedPrimaryKeyWhere(account, { id: 4 })).toEqual({ id: 4 });
    expect(
      getProvidedPrimaryKeyWhere(account, { id: sql`${4}` })
    ).toBeUndefined();
    expect(() =>
      assertCreateRefetchIdentity(scope, { id: 4 }, "account")
    ).not.toThrow();
    expect(getCreatedRowWhere(scope, { id: 4 }, "account")).toEqual({ id: 4 });
  });

  test("checks portable primary-key envelopes for each mutation family", () => {
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(bigintIdentity, "upsert", {
        update: { id: { increment: 1n } },
      })
    ).not.toThrow();
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(numberIdentity, "updateMany", {
        data: { id: { increment: 1 } },
      })
    ).toThrow("not portable for number primary key");
  });
});

describe("mutation dependency fold boundaries", () => {
  const write = (
    id: string,
    statement: WriteStep["statement"],
    outputs: WriteStep["outputs"]
  ): WriteStep => ({ id, kind: "write", statement, outputs });

  test("addresses root and sibling output columns through their distinct CTE names", () => {
    const root = write(
      "account.create",
      sql`INSERT INTO account DEFAULT VALUES`,
      { id: { kind: "firstRowField", field: "id" } }
    );
    const child = write(
      "entry.create",
      sql`INSERT INTO entry (account_id) VALUES (${ref(
        "account.create",
        "id"
      )})`,
      { id: { kind: "firstRowField", field: "id" } }
    );
    const grandchild = write(
      "leaf.create",
      sql`INSERT INTO leaf (entry_id) VALUES (${ref("entry.create", "id")})`,
      {}
    );
    const folded = compileMutationDependencyFold(
      scopeFor(new PostgresAdapter(), account),
      [root, child, grandchild]
    );

    expect(folded?.[0]?.toStatement("$n")).toContain(
      'FROM "__viborm_mutation"'
    );
    expect(folded?.[1]?.toStatement("$n")).toContain('FROM "__viborm_write_0"');
  });
});

describe("pending operation coordination boundaries", () => {
  function pendingFixture() {
    const pendingUser = s.model({ id: s.string().id(), name: s.string() });
    const schema = { pendingUser };
    hydrateSchemaNames(schema);
    const driver = new PlanningDriver("postgresql");
    const engine = new QueryEngine(
      driver,
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    return { pendingUser, driver, engine };
  }

  test("recognizes genuine pending operations and refuses unrelated values", () => {
    const { pendingUser, engine } = pendingFixture();
    const operation = engine.prepare(pendingUser, "findMany", {});

    expect(isPendingOperation(operation)).toBe(true);
    expect(isPendingOperation(null)).toBe(false);
    expect(isPendingOperation("pending")).toBe(false);
    expect(isPendingOperation({})).toBe(false);
    expect(isPendingOperation({ [PENDING_OPERATION_SYMBOL]: false })).toBe(
      false
    );
  });

  test("runs an unintercepted array child without provider work", async () => {
    const { pendingUser, engine } = pendingFixture();
    const operation = engine.prepare(pendingUser, "findMany", {});
    const owner = readTransactionOperation(operation);
    if (!owner) throw new Error("Expected pending-operation authority.");
    const child = () => Promise.resolve("child-result");

    await expect(
      owner.startInterception(
        operation,
        child,
        new TransactionWriteOutcomes(),
        {}
      )
    ).resolves.toBe("child-result");
  });

  test("executes reserved core work through the operation authority", async () => {
    const { pendingUser, driver, engine } = pendingFixture();
    const source = engine.prepare<string>(pendingUser, "findMany", {});
    const operation = attachPendingCacheExecution(source, () =>
      Promise.resolve("core-result")
    );
    const owner = readTransactionOperation(operation);
    if (!owner) throw new Error("Expected pending-operation authority.");

    owner.reserveWith(operation, driver);
    await expect(owner.executeCore(operation, driver)).resolves.toBe(
      "core-result"
    );
  });
});

describe("coverage low value", () => {
  test("contains malformed cursor state rejected before operation planning", () => {
    const scope = scopeFor(new SQLiteAdapter(), account);

    expect(() => buildCursorCondition(scope, [], [])).toThrow(
      "requires at least one scalar order field"
    );
    expect(() =>
      buildCursorCondition(
        scope,
        [{ fieldName: "id", value: null }],
        [
          {
            field: "id",
            expression: scope.adapter.identifiers.column(scope.rootAlias, "id"),
            direction: "asc",
            nulls: "last",
            nullable: false,
            isTieBreaker: false,
          },
        ]
      )
    ).toThrow("Cursor field 'id' cannot be null");
  });

  test("contains malformed aggregate filters rejected by operation schemas", () => {
    const scope = scopeFor(new PostgresAdapter(), account);

    expect(() =>
      buildHaving(scope, { id: { _count: { in: 1 } } }, scope.rootAlias, [])
    ).toThrow("HAVING operation 'in' requires an array value");
    expect(() =>
      buildHaving(scope, { id: { _count: { notIn: 1 } } }, scope.rootAlias, [])
    ).toThrow("HAVING operation 'notIn' requires an array value");
    expect(() =>
      buildHaving(
        scope,
        { id: { _count: { unsupported: 1 } } },
        scope.rootAlias,
        []
      )
    ).toThrow("Invalid operator: unsupported");
    expect(
      buildHaving(
        scope,
        { AND: { name: undefined }, name: undefined },
        scope.rootAlias,
        ["name"]
      )
    ).toBeUndefined();
    expect(
      buildHaving(scope, { id: { _count: undefined } }, scope.rootAlias, [])
    ).toBeUndefined();
    expect(() =>
      buildHaving(
        scope,
        { amount: { _sum: { equals: "not-a-decimal" } } },
        scope.rootAlias,
        []
      )
    ).toThrow();
  });

  test("contains malformed HAVING carriers and ignored aggregate members", () => {
    const scope = scopeFor(new PostgresAdapter(), account);

    expect(
      buildHaving(
        scope,
        null as unknown as Record<string, unknown>,
        scope.rootAlias,
        []
      )
    ).toBeUndefined();
    expect(
      buildHaving(
        scope,
        { OR: { name: { equals: "group-a" } } },
        scope.rootAlias,
        ["name"]
      )?.values
    ).toContain("group-a");
    expect(
      buildHaving(
        scope,
        {
          id: {
            _count: { gt: 0 },
            ignoredAggregateMember: { equals: 1 },
          },
        },
        scope.rootAlias,
        []
      )?.toStatement("$n")
    ).toContain("COUNT");
    expect(
      buildHaving(
        scope,
        { id: { _count: { equals: undefined } } },
        scope.rootAlias,
        []
      )
    ).toBeUndefined();
  });

  test("contains empty post-validation group order members", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const statement = buildGroupBy(scope, {
      by: ["name"],
      orderBy: [{ name: undefined }, { _count: { id: undefined } }],
    });

    expect(statement.toStatement("$n")).not.toContain("ORDER BY");
  });

  test("contains dependency references that cannot name an earlier output column", () => {
    const scope = scopeFor(new PostgresAdapter(), account);
    const root: WriteStep = {
      id: "account.create",
      kind: "write",
      statement: sql`INSERT INTO account DEFAULT VALUES`,
      outputs: { id: { kind: "firstRowField", field: "id" } },
    };
    const external: WriteStep = {
      id: "entry.external",
      kind: "write",
      statement: sql`INSERT INTO entry VALUES (${ref("outside", "id")})`,
      outputs: {},
    };
    const missingOutput: WriteStep = {
      id: "entry.missing",
      kind: "write",
      statement: sql`INSERT INTO entry VALUES (${ref(
        "account.create",
        "missing"
      )})`,
      outputs: {},
    };
    const optionalRoot: WriteStep = {
      ...root,
      outputs: {
        id: { kind: "firstRowField", field: "id", optional: true },
      },
    };
    const optionalConsumer: WriteStep = {
      id: "entry.optional",
      kind: "write",
      statement: sql`INSERT INTO entry VALUES (${ref("account.create", "id")})`,
      outputs: {},
    };

    expect(
      compileMutationDependencyFold(scope, [root, external])
    ).toBeUndefined();
    expect(
      compileMutationDependencyFold(scope, [root, missingOutput])
    ).toBeUndefined();
    expect(
      compileMutationDependencyFold(scope, [optionalRoot, optionalConsumer])
    ).toBeUndefined();
  });

  test("contains corrupted post-validation primary-key operations", () => {
    for (const value of [null, undefined, sql`${1}`]) {
      expect(() =>
        getUpdatedPrimaryKeyValue(
          numberIdentity,
          "id",
          1,
          value,
          "numberIdentity"
        )
      ).toThrow("uses an unsupported operation");
    }
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        1,
        { set: null },
        "numberIdentity"
      )
    ).toThrow("uses an unsupported operation");
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        1,
        { rotate: 2 },
        "numberIdentity"
      )
    ).toThrow("uses an unsupported operation");
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        " ",
        { increment: 1 },
        "numberIdentity"
      )
    ).toThrow("uses an unsupported operation");
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        2n ** 80n,
        { increment: 1 },
        "numberIdentity"
      )
    ).toThrow("uses an unsupported operation");
    expect(() =>
      getUpdatedPrimaryKeyValue(
        bigintIdentity,
        "id",
        1n,
        { divide: 0n },
        "bigintIdentity"
      )
    ).toThrow("divide a primary key by zero");
    expect(() =>
      getUpdatedPrimaryKeyValue(
        numberIdentity,
        "id",
        Number.MAX_VALUE,
        { multiply: Number.MAX_VALUE },
        "numberIdentity"
      )
    ).toThrow("non-finite number");

    expect(() =>
      assertPortablePrimaryKeyUpdateInput(account, "update", {
        data: { id: {} },
      })
    ).toThrow("received none");
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(account, "update", {
        data: { id: { set: 1, increment: 1 } },
      })
    ).toThrow("received set, increment");
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(account, "update", {
        data: { id: { divide: 0 } },
      })
    ).toThrow("by zero");
    expect(() =>
      assertPortablePrimaryKeyUpdateInput(account, "update", {
        data: { id: { increment: Number.POSITIVE_INFINITY } },
      })
    ).toThrow("non-finite 'increment' operand");

    const unnamedKeyless = s.model({ value: s.string() });
    expect(() => planNestedCreateIdentity(unnamedKeyless, {})).toThrow(
      "Nested create requires primary key field 'id'"
    );
  });
});
