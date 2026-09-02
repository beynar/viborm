/**
 * The junction insert's duplicate-skip clause, per dialect (polymorphic
 * cardinality plan §1.7 / §9.4, Package D fence A).
 *
 * WHAT MOVED. Every junction INSERT used to end in the UNTARGETED skip
 * (`adapter.mutations.skipDuplicates`) — `ON CONFLICT DO NOTHING` on
 * PostgreSQL/SQLite/D1, a duplicate-key-only no-op UPDATE on MySQL. It now names
 * the COMPLETE membership key on every dialect that can carry a conflict target.
 *
 * WHY, and it is not an optimization. A polymorphic member table whose inverse
 * is singular carries a target-side UNIQUE as well as the membership PK, and
 * those two constraints mean opposite things: a collision on the PK is the same
 * `(owner, target)` row arriving twice, which connect promises is idempotent; a
 * collision on the target-side UNIQUE is a DIFFERENT owner already holding the
 * slot, which a transfer-semantics verb vacates first and a plain insert must
 * report. The untargeted clause answers both with silence. On the native-batch
 * substrate that unique is the SOLE arbiter of the race (plan §3), so the
 * targeting has to land before the transfer does.
 *
 * WHY UNIFORMLY, ordinary pair tables included (§9.4, open question 1, decided).
 * A pair table's PK is its only unique constraint, so naming it skips exactly
 * the rows the untargeted clause skipped — the byte churn in the junction pins
 * is the entire cost. A `cardinality`-shaped branch inside the SQL builder would
 * have avoided that churn at the price of a second answer to one question.
 *
 * WHAT THIS FILE PINS: the emitted clause, per dialect, for both junction insert
 * shapes (VALUES and INSERT…SELECT), scalar and compound sides. The SEMANTIC
 * falsifiers — an exact reconnect stays idempotent while an occupied slot
 * raises, on each substrate — need a singular member table to write against and
 * belong to the collection write family (§13.4), which lands with fence B.
 *
 * FALSIFY: drop the `supportsTargetedUpsert` branch in `junctionDuplicateSkip`
 * and MySQL emits `ON DUPLICATE KEY UPDATE NOTHING`; invert it and PostgreSQL
 * goes back to swallowing an occupied slot. Narrow the target to the source
 * columns alone and PostgreSQL/SQLite stop inferring any index at all — which is
 * why the last test compares the target against the INSERT's own column list
 * rather than against a literal.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  buildJunctionMembership,
  buildJunctionParentValue,
  buildJunctionReferencedValuesSetMatch,
  buildJunctionTargetSubqueriesMatch,
  buildJunctionTargetValue,
  buildJunctionTargetValuesMatch,
} from "@query-engine/builders/many-to-many-utils";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { lookupRelation } from "@query-engine/context";
import { JunctionStatements } from "@query-engine/JunctionStatements";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

/** Scalar row keys on both sides, with explicit junction column tokens. */
const scalarPair = (() => {
  const shelf = s
    .model({
      id: s.string().id(),
      books: s
        .toMany(() => book)
        .through("jct_shelf_book")
        .source("shelf")
        .target("book"),
    })
    .map("jct_shelves");
  // ONE endpoint owns every junction override (§4.4, R011).
  const book = s
    .model({
      id: s.string().id(),
      shelves: s.toMany(() => shelf),
    })
    .map("jct_books");
  return { shelf, book };
})();
prepareSchema(scalarPair);

/** Compound row keys on BOTH sides — four junction columns, one membership key. */
const compoundPair = (() => {
  const owner = s
    .model({
      tenantId: s.string(),
      code: s.string(),
      items: s
        .toMany(() => item)
        .through("jct_owner_item")
        .source("owner")
        .target("item"),
    })
    .id(["tenantId", "code"])
    .map("jct_owners");
  const item = s
    .model({
      region: s.string(),
      isbn: s.string(),
      owners: s.toMany(() => owner),
    })
    .id(["region", "isbn"])
    .map("jct_items");
  return { owner, item };
})();
prepareSchema(compoundPair);

const postgres = new PostgresAdapter();
const sqlite = new SQLiteAdapter();
const mysql = new MySQLAdapter();

const INSERT_COLUMNS = /INSERT\s+INTO\s+\S+\s+\(([^)]*)\)/;
const CONFLICT_TARGET = /ON CONFLICT \(([^)]*)\)/;

function junctionInsert(
  adapter: DatabaseAdapter,
  source: Model<any>,
  relationName: string,
  args: Record<string, unknown>,
  placeholder: "$n" | "?"
): string {
  const scope = scopeFor(adapter, source);
  const relationRef = lookupRelation(scope, relationName);
  if (!relationRef) {
    throw new Error(`Expected relation '${relationName}' on the test model.`);
  }
  const relation = bindRelation(scope, relationRef);
  if (relation.position !== "junction") {
    throw new Error(`Expected relation '${relationName}' to bind a junction.`);
  }
  const operation =
    args.joinWhenTargetExists === true
      ? "junctionInsert"
      : "junctionInsertMany";
  return new JunctionStatements(scope, false)
    .materialize(relation, operation, args)
    .toStatement(placeholder);
}

function boundJunction(
  adapter: DatabaseAdapter,
  source: Model<any>,
  relationName: string
) {
  const scope = scopeFor(adapter, source);
  const relationRef = lookupRelation(scope, relationName);
  if (!relationRef) throw new Error(`Expected relation '${relationName}'.`);
  const relation = bindRelation(scope, relationRef);
  if (relation.position !== "junction") {
    throw new Error(`Expected '${relationName}' to use a junction.`);
  }
  return { scope, relation };
}

const scalarRows = { parentValue: "s1", targetValues: ["b1", "b2"] };
const scalarJoin = {
  parentValue: "s1",
  targetValue: "b1",
  joinWhenTargetExists: true,
};
const compoundRows = {
  parentValue: { tenantId: "t1", code: "c1" },
  targetValues: [{ region: "eu", isbn: "i1" }],
};

describe("junction insert duplicate-skip clause", () => {
  test("PostgreSQL names the complete membership key", () => {
    expect(
      junctionInsert(postgres, scalarPair.shelf, "books", scalarRows, "$n")
    ).toBe(
      'INSERT  INTO "public"."jct_shelf_book" ("shelf", "book") VALUES ($1, $2), ($3, $4) ON CONFLICT ("shelf", "book") DO NOTHING'
    );
  });

  test("SQLite (and D1, which runs this adapter) names the same key", () => {
    expect(
      junctionInsert(sqlite, scalarPair.shelf, "books", scalarRows, "?")
    ).toBe(
      'INSERT  INTO "jct_shelf_book" ("shelf", "book") VALUES (?, ?), (?, ?) ON CONFLICT ("shelf", "book") DO NOTHING'
    );
  });

  /*
   * MySQL is BYTE-IDENTICAL to what it emitted before §1.7, and that is the
   * point of pinning it: `ON DUPLICATE KEY UPDATE` carries no target at all
   * (`capabilities.supportsTargetedUpsert` is false there and its doc comment
   * explains why the difference is a wrong answer rather than a missing
   * feature), so the clause stays the duplicate-key-only no-op update. Correct
   * for every junction whose PK is its sole unique constraint — which is every
   * ordinary pair table. The singular-member remainder is fence B's seam,
   * recorded at `junctionDuplicateSkip`.
   */
  test("MySQL keeps the untargeted no-op update, unchanged", () => {
    const statement = junctionInsert(
      mysql,
      scalarPair.shelf,
      "books",
      scalarRows,
      "?"
    );
    expect(statement).toBe(
      "INSERT  INTO `jct_shelf_book` (`shelf`, `book`) VALUES (?, ?), (?, ?) ON DUPLICATE KEY UPDATE `shelf` = `shelf`"
    );
    expect(statement).not.toContain("ON CONFLICT");
  });

  test("a compound membership key names every column of both sides", () => {
    expect(
      junctionInsert(postgres, compoundPair.owner, "items", compoundRows, "$n")
    ).toBe(
      'INSERT  INTO "public"."jct_owner_item" ("owner_1", "owner_2", "item_1", "item_2") VALUES ($1, $2, $3, $4) ON CONFLICT ("owner_1", "owner_2", "item_1", "item_2") DO NOTHING'
    );
  });

  /*
   * `buildJunctionInsertWhenTargetExists` — the INSERT…SELECT shape a junction
   * `createMany({ skipDuplicates: true })` reaches. It had the same untargeted
   * skip and therefore the same swallow, so it takes the same target. SQLite
   * needs the SELECT to carry a WHERE for the `ON` keyword to parse
   * unambiguously; this builder always emits one (the complete target key
   * match), which is why the shape stays legal there.
   */
  test("the insert-from-select shape carries the same target", () => {
    expect(
      junctionInsert(postgres, scalarPair.shelf, "books", scalarJoin, "$n")
    ).toContain('ON CONFLICT ("shelf", "book") DO NOTHING');
    const sqliteStatement = junctionInsert(
      sqlite,
      scalarPair.shelf,
      "books",
      scalarJoin,
      "?"
    );
    expect(sqliteStatement).toContain('ON CONFLICT ("shelf", "book")');
    expect(sqliteStatement.indexOf("WHERE")).toBeLessThan(
      sqliteStatement.indexOf("ON CONFLICT")
    );
  });

  /*
   * The invariant behind every literal above, stated against the statement
   * itself rather than against a remembered column list: PostgreSQL and SQLite
   * infer the arbiter index from the conflict target as a SET, so a COMPLETE key
   * infers the membership PK whatever order it is written in, and an INCOMPLETE
   * one infers nothing and raises at execution. Naming exactly the INSERT's own
   * columns is what makes the clause complete by construction.
   */
  test("the conflict target is exactly the INSERT's own column list", () => {
    const cases = [
      [scalarPair.shelf, "books", scalarRows],
      [compoundPair.owner, "items", compoundRows],
    ] as const;
    const dialects = [
      [postgres, "$n"],
      [sqlite, "?"],
    ] as const;
    for (const [source, relationName, args] of cases) {
      for (const [adapter, placeholder] of dialects) {
        const statement = junctionInsert(
          adapter,
          source,
          relationName,
          args,
          placeholder
        );
        const inserted = INSERT_COLUMNS.exec(statement)?.[1];
        expect(inserted).toBeDefined();
        expect(CONFLICT_TARGET.exec(statement)?.[1]).toBe(inserted);
      }
    }
  });
});

describe("compound junction predicates", () => {
  test("preserves every endpoint member through value and membership predicates", () => {
    const { scope, relation } = boundJunction(
      postgres,
      compoundPair.owner,
      "items"
    );
    const parent = buildJunctionParentValue(
      scope,
      relation,
      { tenantId: "tenant-1", code: "owner-1" },
      "items"
    );
    const firstTarget = buildJunctionTargetValue(
      scope,
      relation,
      { region: "eu", isbn: "isbn-1" },
      "items"
    );
    const secondTarget = buildJunctionTargetValue(
      scope,
      relation,
      { region: "us", isbn: "isbn-2" },
      "items"
    );

    expect(parent.flatMap((value) => value.values)).toEqual([
      "tenant-1",
      "owner-1",
    ]);
    expect(firstTarget.flatMap((value) => value.values)).toEqual([
      "eu",
      "isbn-1",
    ]);

    const targetSet = buildJunctionTargetValuesMatch(
      scope,
      relation,
      [firstTarget, secondTarget],
      "membership"
    ).toStatement("$n");
    expect(targetSet).toContain('"membership"."item_1" = $1');
    expect(targetSet).toContain('"membership"."item_2" = $2');
    expect(targetSet).toContain('"membership"."item_1" = $3');
    expect(targetSet).toContain('"membership"."item_2" = $4');

    const referencedSet = buildJunctionReferencedValuesSetMatch(
      scope,
      relation.membership.target,
      [firstTarget, secondTarget],
      "candidate"
    ).toStatement("$n");
    expect(referencedSet).toContain('"candidate"."region" = $1');
    expect(referencedSet).toContain('"candidate"."isbn" = $2');

    const membership = buildJunctionMembership(
      scope,
      relation,
      parent,
      "candidate"
    ).toStatement("$n");
    expect(membership).toContain("EXISTS");
    expect(membership).toContain('"candidate"."region"');
    expect(membership).toContain('"candidate"."isbn"');
    // The SELECT projection owns $1. The correlated owner tuple follows it.
    expect(membership).toContain('"jct_owner_item"."owner_1" = $2');
    expect(membership).toContain('"jct_owner_item"."owner_2" = $3');
  });

  test("matches every compound junction column to its target subquery", () => {
    const { scope, relation } = boundJunction(
      postgres,
      compoundPair.owner,
      "items"
    );
    const condition = buildJunctionTargetSubqueriesMatch(
      scope,
      relation,
      [sql`(SELECT ${"eu"})`, sql`(SELECT ${"isbn-1"})`],
      "membership"
    ).toStatement("$n");

    expect(condition).toBe(
      '("membership"."item_1" = (SELECT $1) AND "membership"."item_2" = (SELECT $2))'
    );
  });
});

describe("coverage low value", () => {
  test("contains junction tuples that bound topology cannot produce", () => {
    const { scope, relation } = boundJunction(
      postgres,
      compoundPair.owner,
      "items"
    );

    expect(() =>
      buildJunctionTargetValuesMatch(scope, relation, [[sql`${"eu"}`]])
    ).toThrow("Junction side value count does not match its stored reference.");
    expect(() =>
      buildJunctionParentValue(
        scope,
        relation,
        { tenantId: "tenant-1" },
        "items"
      )
    ).toThrow("parent record is missing primary key field 'code'");
  });
});
