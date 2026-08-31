import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  buildDeleteMany,
  buildDeleteManyAndReturn,
} from "@query-engine/operations/delete";
import { buildGroupBy } from "@query-engine/operations/groupby";
import { buildHaving } from "@query-engine/operations/groupby-having";
import {
  buildUpdateMany,
  buildUpdateManyAndReturn,
} from "@query-engine/operations/update";
import { buildUpsert } from "@query-engine/operations/upsert";
import { s } from "@schema";
import { sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const record = s.model({
  id: s.int().id(),
  name: s.string(),
  active: s.boolean(),
});
const grouped = s.model({
  id: s.int().id(),
  _sum: s.int(),
  score: s.int(),
});

prepareSchema({ record, grouped });

describe("bulk mutation statement boundaries", () => {
  test("composes trusted predicates with and without a public filter", () => {
    const scope = scopeFor(new PostgresAdapter(), record);
    const predicate = sql`${3} > ${2}`;
    const predicateOnlyDelete = buildDeleteMany(scope, { predicate });
    const composedDelete = buildDeleteMany(scope, {
      where: { active: { equals: true } },
      predicate,
    });
    const predicateOnlyUpdate = buildUpdateMany(scope, {
      data: { name: { set: "updated" } },
      predicate,
    });

    expect(predicateOnlyDelete.toStatement("$n")).toContain("WHERE $1 > $2");
    expect(composedDelete.toStatement("$n")).toContain(" AND ");
    expect(composedDelete.values).toEqual([true, 3, 2]);
    expect(predicateOnlyUpdate.toStatement("$n")).toContain("WHERE $2 > $3");
    expect(predicateOnlyUpdate.values).toEqual(["updated", 3, 2]);
  });

  test("keeps non-returning bulk statements unchanged on MySQL", () => {
    const scope = scopeFor(new MySQLAdapter(), record);
    const deleted = buildDeleteMany(scope, {
      where: { active: { equals: false } },
    });
    const deletedWithReturn = buildDeleteManyAndReturn(scope, {
      where: { active: { equals: false } },
      select: { id: true },
    });
    const updated = buildUpdateMany(scope, {
      data: { name: { set: "updated" } },
      where: { active: { equals: true } },
    });
    const updatedWithReturn = buildUpdateManyAndReturn(scope, {
      data: { name: { set: "updated" } },
      where: { active: { equals: true } },
      select: { id: true },
    });

    expect(deletedWithReturn.toStatement("?")).toBe(deleted.toStatement("?"));
    expect(deletedWithReturn.values).toEqual(deleted.values);
    expect(updatedWithReturn.toStatement("?")).toBe(updated.toStatement("?"));
    expect(updatedWithReturn.values).toEqual(updated.values);
  });
});

describe("upsert statement boundaries", () => {
  test("threads target and update predicates through the adapter-owned upsert", () => {
    const scope = scopeFor(new PostgresAdapter(), record);
    const statement = buildUpsert(scope, {
      where: { id: 1 },
      create: { id: 1, name: "created", active: true },
      update: { name: { set: "updated" } },
      targetWhere: { active: { equals: true } },
      setWhere: { active: { equals: false } },
      select: { id: true },
    });
    const text = statement.toStatement("$n");

    expect(text).toContain("ON CONFLICT");
    expect(text).toContain("DO UPDATE SET");
    expect(text).toContain("RETURNING");
    expect(text.match(/WHERE/g)).toHaveLength(2);
  });
});

describe("groupBy and having boundaries", () => {
  test("refuses one output name shared by a grouped scalar and aggregate", () => {
    const scope = scopeFor(new PostgresAdapter(), grouped);

    expect(() =>
      buildGroupBy(scope, {
        by: ["_sum"],
        _sum: { score: true },
      })
    ).toThrow(
      "GroupBy cannot return both grouped scalar '_sum' and aggregate '_sum'"
    );
  });

  test("normalizes a direct grouped-field having value to equality", () => {
    const scope = scopeFor(new PostgresAdapter(), grouped);
    const having = buildHaving(scope, { score: 7 }, scope.rootAlias, ["score"]);

    expect(having?.toStatement("$n")).toBe('"t0"."score" = $1');
    expect(having?.values).toEqual([7]);
  });
});

describe("coverage low value", () => {
  test("contains empty upsert input rejected by the operation schema", () => {
    const scope = scopeFor(new PostgresAdapter(), record);

    expect(() =>
      buildUpsert(scope, {
        where: { id: 1 },
        create: {},
        update: { name: { set: "updated" } },
      })
    ).toThrow("No data to insert");
  });
});
