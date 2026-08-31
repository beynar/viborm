/**
 * Complete list operands cross the adapter boundary as one container.
 *
 * PostgreSQL previously regressed `push`/`unshift` into one nested SQL fragment
 * and bind per member while teaching enum lists their managed element type. A
 * list's normal whole-value crossing already owns that type decision; update
 * concatenation and containment filters must consume it rather than rebuilding
 * members.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { buildSet } from "@query-engine/builders/set-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import { s } from "@schema";
import { sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const entry = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  owner: s
    .toOne(() => owner)
    .fields("ownerId")
    .references("id"),
  name: s.string().map("display_name"),
  score: s.int(),
  factor: s.number(),
  ratio: s.int(),
  amount: s.decimal({ precision: 12, scale: 2 }),
  scores: s.int().array(),
  statuses: s.enum(["ACTIVE", "PAUSED", "DONE"]).array(),
  instants: s.dateTime().array(),
});
const owner = s.model({
  id: s.string().id(),
  entries: s.toMany(() => entry),
});

prepareSchema({ entry, owner });

describe("whole-list container crossing", () => {
  test("PostgreSQL keeps an ordinary large append at one bind and constant SQL depth", () => {
    const values = Array.from({ length: 65_536 }, (_, index) => index);
    const statement = buildSet(scopeFor(new PostgresAdapter(), entry), {
      scores: { push: values },
    });

    expect(statement.toStatement("$n")).toBe(
      `"scores" = array_cat(COALESCE("scores", '{}'), $1)`
    );
    expect(statement.values).toEqual([values]);
  });

  test("PostgreSQL gives an enum append one typed array-literal bind", () => {
    const statement = buildSet(scopeFor(new PostgresAdapter(), entry), {
      statuses: { push: ["PAUSED", "DONE"] },
    });

    expect(statement.toStatement("$n")).toBe(
      `"statuses" = array_cat(COALESCE("statuses", '{}'), $1)`
    );
    expect(statement.values).toEqual(['{"PAUSED","DONE"}']);
  });

  test("PostgreSQL containment keeps native and enum candidates at one bind", () => {
    const scoreScope = scopeFor(new PostgresAdapter(), entry);
    const scores = buildWhere(
      scoreScope,
      { scores: { hasEvery: [1, 2] } },
      scoreScope.rootAlias
    );
    const statusScope = scopeFor(new PostgresAdapter(), entry);
    const statuses = buildWhere(
      statusScope,
      { statuses: { hasSome: ["ACTIVE", "DONE"] } },
      statusScope.rootAlias
    );
    if (!(scores && statuses)) {
      throw new Error("Expected PostgreSQL containment predicates.");
    }

    expect(scores.toStatement("$n")).toBe('"t0"."scores" @> $1');
    expect(scores.values).toEqual([[1, 2]]);
    expect(statuses.toStatement("$n")).toBe('"t0"."statuses" && $1');
    expect(statuses.values).toEqual(['{"ACTIVE","DONE"}']);
  });

  test("JSON dialects prepend the same ordered provider container", () => {
    const mysql = buildSet(scopeFor(new MySQLAdapter(), entry), {
      statuses: { unshift: ["PAUSED", "DONE"] },
    });
    const sqlite = buildSet(scopeFor(new SQLiteAdapter(), entry), {
      statuses: { unshift: ["PAUSED", "DONE"] },
    });

    expect(mysql.values).toEqual(['["PAUSED","DONE"]']);
    expect(new Set(sqlite.values)).toEqual(new Set(['["PAUSED","DONE"]']));
    expect(mysql.toStatement()).toContain("JSON_MERGE_PRESERVE");
    expect(sqlite.toStatement()).toContain("substr");
  });

  test("JSON dialect membership keeps DateTime members in the stored ISO vocabulary", () => {
    const first = "2024-01-02T03:04:05.000Z";
    const second = "2024-02-03T04:05:06.000Z";
    const both = JSON.stringify([first, second]);
    const onlySecond = JSON.stringify([second]);

    {
      const scope = scopeFor(new MySQLAdapter(), entry);
      const has = buildWhere(
        scope,
        { instants: { has: first } },
        scope.rootAlias
      );
      const hasEvery = buildWhere(
        scope,
        { instants: { hasEvery: [first, second] } },
        scope.rootAlias
      );
      const hasSome = buildWhere(
        scope,
        { instants: { hasSome: [second] } },
        scope.rootAlias
      );
      if (!(has && hasEvery && hasSome)) {
        throw new Error("Expected MySQL DateTime containment predicates.");
      }

      expect(has.values).toEqual([first]);
      expect(has.toStatement("?")).toBe(
        "JSON_CONTAINS(`t0`.`instants`, JSON_ARRAY(?))"
      );
      expect(hasEvery.values).toEqual([both]);
      expect(hasEvery.toStatement("?")).toBe(
        "JSON_CONTAINS(`t0`.`instants`, CAST(? AS JSON))"
      );
      expect(hasSome.values).toEqual([onlySecond]);
      expect(hasSome.toStatement("?")).toBe(
        "JSON_OVERLAPS(`t0`.`instants`, CAST(? AS JSON))"
      );
    }

    {
      const scope = scopeFor(new SQLiteAdapter(), entry);
      const has = buildWhere(
        scope,
        { instants: { has: first } },
        scope.rootAlias
      );
      const hasEvery = buildWhere(
        scope,
        { instants: { hasEvery: [first, second] } },
        scope.rootAlias
      );
      const hasSome = buildWhere(
        scope,
        { instants: { hasSome: [second] } },
        scope.rootAlias
      );
      if (!(has && hasEvery && hasSome)) {
        throw new Error("Expected SQLite DateTime containment predicates.");
      }

      expect(has.values).toEqual([first]);
      expect(hasEvery.values).toEqual([both, both]);
      expect(hasSome.values).toEqual([onlySecond]);
    }
  });
});

describe("set assignment boundaries", () => {
  test("qualifies mapped assignments and preserves direct SQL and normalized null", () => {
    const scope = scopeFor(new PostgresAdapter(), entry);
    const statement = buildSet(
      scope,
      {
        name: { set: "after" },
        score: sql`${7}`,
        factor: { set: null },
      },
      "updated"
    );

    expect(statement.toStatement("$n")).toBe(
      '"updated"."display_name" = $1, "updated"."score" = $2, "updated"."factor" = NULL'
    );
    expect(statement.values).toEqual(["after", 7]);
  });

  test("delegates each arithmetic target with its declared numeric domain", () => {
    const statement = buildSet(scopeFor(new PostgresAdapter(), entry), {
      score: { decrement: 2 },
      factor: { multiply: 1.5 },
      ratio: { divide: 2 },
      amount: { increment: "1.25" },
    });

    expect(statement.toStatement("$n")).toBe(
      '"score" = "score" - $1, "factor" = "factor" * $2, "ratio" = "ratio" / $3, "amount" = "amount" + CAST($4 AS NUMERIC(12,2))'
    );
    expect(statement.values).toEqual([2, 1.5, 2, "1.25"]);
  });

  test("refuses exact decimal division by zero before statement execution", () => {
    expect(() =>
      buildSet(scopeFor(new PostgresAdapter(), entry), {
        amount: { divide: "0.00" },
      })
    ).toThrow("Cannot divide decimal field 'amount' by zero.");
  });

  test("leaves relation members to their relation compiler", () => {
    const statement = buildSet(scopeFor(new PostgresAdapter(), entry), {
      name: { set: "kept" },
      owner: { connect: { id: "owner-1" } },
    });

    expect(statement.toStatement("$n")).toBe('"display_name" = $1');
    expect(statement.values).toEqual(["kept"]);
  });
});

describe("where semantic boundaries", () => {
  function statement(filter: Record<string, unknown>): string | undefined {
    const scope = scopeFor(new PostgresAdapter(), entry);
    return buildWhere(scope, filter, scope.rootAlias)?.toStatement("$n");
  }

  test("gives empty logical and membership sets their public truth values", () => {
    expect(statement({ OR: [] })).toBe("FALSE");
    expect(statement({ AND: [] })).toBeUndefined();
    expect(statement({ NOT: [] })).toBeUndefined();
    expect(statement({ score: { in: [] } })).toBe("FALSE");
    expect(statement({ score: { notIn: [] } })).toBe("TRUE");
  });

  test("keeps empty and null list predicates provider-portable", () => {
    expect(statement({ scores: { hasEvery: [] } })).toBe(
      '"t0"."scores" IS NOT NULL'
    );
    expect(statement({ scores: { hasSome: [] } })).toBe("FALSE");
    expect(statement({ scores: { isEmpty: false } })).toContain("NOT");
  });

  test("compares complete list containers for equality and inequality", () => {
    expect(statement({ scores: { equals: [1, 2] } })).toBe(
      '"t0"."scores" = $1'
    );
    expect(statement({ scores: { not: [2, 3] } })).toBe(
      '"t0"."scores" <> $1'
    );
  });
});

describe("coverage low value", () => {
  test("contains update shapes that the operation schema rejects upstream", () => {
    const scope = scopeFor(new PostgresAdapter(), entry);

    expect(buildSet(scope, { factor: null }).toStatement("$n")).toBe(
      '"factor" = NULL'
    );
    expect(() =>
      buildSet(scope, {
        name: undefined,
        missing: { set: "ignored" },
      })
    ).toThrow("No fields to update");
    expect(() => buildSet(scope, { score: 1 })).toThrow(
      "Update value must be an operation object"
    );
    expect(() => buildSet(scope, { score: { unsupported: 1 } })).toThrow(
      "Unknown update operation: unsupported"
    );
  });

  test("contains malformed filters rejected by operation schemas", () => {
    const scope = scopeFor(new PostgresAdapter(), entry);
    const where = (filter: Record<string, unknown>) =>
      buildWhere(scope, filter, scope.rootAlias);

    expect(where({ scores: { has: null } })?.toStatement("$n")).toBe("FALSE");
    expect(() => where({ OR: { score: { equals: 1 } } })).toThrow(
      "Logical OR requires an array value"
    );
    expect(() => where({ score: 1 })).toThrow(
      "must be a filter object"
    );
    expect(() => where({ score: { in: 1 } })).toThrow(
      "requires an array value"
    );
    expect(() => where({ scores: { hasEvery: 1 } })).toThrow(
      "requires an array value"
    );
    expect(() => where({ name: { not: {} } })).toThrow(
      "must contain at least one nested condition"
    );
  });
});
