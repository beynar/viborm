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
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const entry = s.model({
  id: s.string().id(),
  scores: s.int().array(),
  statuses: s.enum(["ACTIVE", "PAUSED", "DONE"]).array(),
  instants: s.dateTime().array(),
});

prepareSchema({ entry });

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
