/**
 * Differ identity arms that no other migration suite reaches.
 *
 * Each contract below is a decision the differ makes about IDENTITY rather
 * than about a value: which constraint name a nameless primary key is dropped
 * under, which dropped member pairs with which added member, and which
 * predicates are worth a round trip to the database.
 */

import { diff, type IndexPredicateCanonicalizer } from "@src/migrations/differ";
import type {
  ColumnDef,
  IndexDef,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";

function column(name: string, type = "text"): ColumnDef {
  return { name, type, nullable: false };
}

function table(
  name: string,
  columns: ColumnDef[],
  overrides: Partial<TableDef> = {}
): TableDef {
  return {
    name,
    columns,
    indexes: [],
    foreignKeys: [],
    uniqueConstraints: [],
    ...overrides,
  };
}

function snapshot(tables: TableDef[]): SchemaSnapshot {
  return { tables };
}

describe("primary-key identity", () => {
  test("drops a nameless primary key under the catalog default name", async () => {
    // The serializer writes junction primary keys WITHOUT a name — the
    // catalog names them `<table>_pkey` itself — so the drop has to supply
    // that name rather than emit `undefined`.
    const columns = [column("postId"), column("tagId")];
    const current = snapshot([
      table("post_tag", columns, {
        primaryKey: { columns: ["postId", "tagId"] },
      }),
    ]);
    const desired = snapshot([table("post_tag", columns)]);

    const result = await diff(current, desired);

    expect(result.operations).toEqual([
      {
        type: "dropPrimaryKey",
        tableName: "post_tag",
        constraintName: "post_tag_pkey",
      },
    ]);
  });
});

describe("rename candidate pairing", () => {
  test("pairs each dropped column with one added column and reuses neither", async () => {
    const current = snapshot([
      table("profile", [column("id"), column("given"), column("family")]),
    ]);
    const desired = snapshot([
      table("profile", [column("id"), column("firstName"), column("lastName")]),
    ]);

    const result = await diff(current, desired);

    // Two compatible drops against two compatible adds is four candidate
    // pairs; only the two that consume a fresh drop AND a fresh add survive,
    // so `given` is never also offered as `lastName`.
    expect(result.ambiguousChanges).toEqual([
      {
        type: "ambiguousColumn",
        tableName: "profile",
        droppedColumn: column("given"),
        addedColumn: column("firstName"),
      },
      {
        type: "ambiguousColumn",
        tableName: "profile",
        droppedColumn: column("family"),
        addedColumn: column("lastName"),
      },
    ]);
    // Every drop and add is claimed by an ambiguity, so nothing is planned
    // until the resolver answers.
    expect(result.operations).toEqual([]);
  });

  test("pairs each dropped table with one added table and reuses neither", async () => {
    const shape = () => [column("id"), column("label")];
    const alpha = table("alpha", shape());
    const beta = table("beta", shape());
    const gamma = table("gamma", shape());
    const delta = table("delta", shape());

    const result = await diff(
      snapshot([alpha, beta]),
      snapshot([gamma, delta])
    );

    expect(result.ambiguousChanges).toEqual([
      {
        type: "ambiguousTable",
        droppedTable: "alpha",
        addedTable: "gamma",
        droppedTableDef: alpha,
        addedTableDef: gamma,
      },
      {
        type: "ambiguousTable",
        droppedTable: "beta",
        addedTable: "delta",
        droppedTableDef: beta,
        addedTableDef: delta,
      },
    ]);
    expect(result.operations).toEqual([]);
  });
});

describe("partial-index predicate canonicalization", () => {
  test("asks the database only for predicates both snapshots spell for one index", async () => {
    const calls: { table: string; predicates: string[] }[] = [];
    const canonicalizeIndexPredicate: IndexPredicateCanonicalizer = (
      tableName,
      predicates
    ) => {
      calls.push({ table: tableName, predicates: [...predicates] });
      return Promise.resolve(predicates.map(() => "a > 0"));
    };

    const columns = () => [column("a", "integer"), column("b", "integer")];
    const declared: IndexDef = {
      name: "pi",
      columns: ["a"],
      unique: false,
      where: "a > 0",
    };
    const deparsed: IndexDef = {
      name: "pi",
      columns: ["a"],
      unique: false,
      where: "(a > 0)",
    };
    const added: IndexDef = { name: "ni", columns: ["b"], unique: false };

    const result = await diff(
      snapshot([table("t", columns(), { indexes: [declared] })]),
      snapshot([table("t", columns(), { indexes: [deparsed, added] })]),
      { canonicalizeIndexPredicate }
    );

    // `ni` exists on one side only. A predicate that cannot differ between the
    // two snapshots buys nothing from the database, so it never enters the
    // round trip — the call carries the two spellings of `pi` and nothing else.
    expect(calls).toEqual([{ table: "t", predicates: ["a > 0", "(a > 0)"] }]);
    // `pi` converged on the database's own spelling, so only the genuinely
    // new index is planned.
    expect(result.operations).toEqual([
      { type: "createIndex", tableName: "t", index: added },
    ]);
  });
});
