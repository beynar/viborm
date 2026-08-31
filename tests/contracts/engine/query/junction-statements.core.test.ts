import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { lookupRelation } from "@query-engine/context";
import {
  type JunctionOperation,
  JunctionStatements,
} from "@query-engine/JunctionStatements";
import { s } from "@schema";
import { sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const scalarSchema = (() => {
  const owner = s.model({
    id: s.int().id(),
    targets: s
      .toMany(() => target)
      .through("junction_statement_memberships")
      .source("owner_id")
      .target("target_id"),
  });
  const target = s.model({
    id: s.int().id(),
    label: s.string(),
    enabled: s.boolean(),
    owners: s.toMany(() => owner),
  });
  return { owner, target };
})();

const compoundSchema = (() => {
  const owner = s
    .model({
      tenant: s.string(),
      code: s.string(),
      targets: s
        .toMany(() => target)
        .through("junction_statement_compound")
        .source("owner")
        .target("target"),
    })
    .id(["tenant", "code"]);
  const target = s
    .model({
      region: s.string(),
      serial: s.int(),
      enabled: s.boolean(),
      owners: s.toMany(() => owner),
    })
    .id(["region", "serial"]);
  return { owner, target };
})();

prepareSchema({
  ...scalarSchema,
  compoundOwner: compoundSchema.owner,
  compoundTarget: compoundSchema.target,
});

function junctionCompiler(
  source: typeof scalarSchema.owner | typeof compoundSchema.owner,
  lockReads = false
) {
  const scope = scopeFor(new PostgresAdapter(), source);
  const relationRef = lookupRelation(scope, "targets");
  if (!relationRef) throw new Error("Expected the targets relation.");
  const relation = bindRelation(scope, relationRef);
  if (relation.position !== "junction") {
    throw new Error("Expected targets to bind through a junction.");
  }
  const statements = new JunctionStatements(scope, lockReads);
  return {
    materialize(operation: JunctionOperation, args: Record<string, unknown>) {
      return statements.materialize(relation, operation, args);
    },
  };
}

describe("junction statement materialization", () => {
  test("distinguishes owner clears, selected-target clears, and exact membership deletes", () => {
    const compiler = junctionCompiler(scalarSchema.owner);
    const ownerClear = compiler.materialize("junctionDelete", {
      parentValue: 1,
    });
    const selectedClear = compiler.materialize("junctionDelete", {
      parentValue: 1,
      targetWhere: { id: 2 },
    });
    const targetClear = compiler.materialize("junctionDeleteTargets", {
      parentValue: 1,
      targetValues: [2, 3],
    });
    const emptyTargetClear = compiler.materialize("junctionDeleteTargets", {
      parentValue: 1,
      targetValues: [],
    });
    const exactClear = compiler.materialize("junctionDeleteExact", {
      parentValue: 1,
      targetValue: 2,
    });

    expect(ownerClear.values).toEqual([1]);
    expect(selectedClear.toStatement("$n")).toContain("SELECT");
    expect(selectedClear.values).toEqual([1, 2]);
    expect(targetClear.values).toEqual([2, 3]);
    expect(emptyTargetClear.toStatement("$n")).toContain("$1 = $2");
    expect(emptyTargetClear.values).toEqual([1, 0]);
    expect(exactClear.values).toEqual([1, 2]);
  });

  test("builds a locked membership read from every supported predicate and projection input", () => {
    const compiler = junctionCompiler(scalarSchema.owner, true);
    const statement = compiler.materialize("membershipRead", {
      parentValue: 1,
      whereUnique: { id: 2 },
      where: { enabled: { equals: true } },
      predicate: sql`${"predicate-marker"} = ${"predicate-marker"}`,
      select: { id: true, label: true },
      additionalColumns: [sql`${7} AS "ordinal"`],
      take: 3,
      lock: "transaction",
    });
    const text = statement.toStatement("$n");

    expect(text).toContain("FOR UPDATE");
    expect(text).toContain("LIMIT");
    expect(text).toContain('AS "ordinal"');
    expect(statement.values).toEqual([
      7,
      1,
      2,
      true,
      "predicate-marker",
      "predicate-marker",
      3,
    ]);
  });

  test("reads the complete current owner tuple and locks it only on request", () => {
    const unlocked = junctionCompiler(scalarSchema.owner).materialize(
      "membershipOwners",
      { targetValue: 2, lock: "transaction" }
    );
    const locked = junctionCompiler(scalarSchema.owner, true).materialize(
      "membershipOwners",
      { targetValue: 2, lock: "transaction" }
    );

    expect(unlocked.toStatement("$n")).not.toContain("FOR UPDATE");
    expect(locked.toStatement("$n")).toContain("FOR UPDATE");
    expect(locked.toStatement("$n")).toContain("LIMIT $2");
    expect(locked.values).toEqual([2, 2]);
  });

  test("spells added and removed membership differences for empty and populated target sets", () => {
    const compiler = junctionCompiler(scalarSchema.owner);
    const added = compiler.materialize("membershipDifference", {
      parentValue: 1,
      targetValues: [2, 3],
      where: { enabled: { equals: true } },
      difference: "added",
    });
    const removed = compiler.materialize("membershipDifference", {
      parentValue: 1,
      targetValues: [2, 3],
      difference: "removed",
    });
    const addedFromEmpty = compiler.materialize("membershipDifference", {
      parentValue: 1,
      targetValues: [],
      difference: "added",
    });
    const removedFromEmpty = compiler.materialize("membershipDifference", {
      parentValue: 1,
      targetValues: [],
      difference: "removed",
    });

    expect(added.toStatement("$n")).toContain("NOT IN");
    expect(added.values).toContain(true);
    expect(removed.toStatement("$n")).toContain("NOT");
    const addedFromEmptyText = addedFromEmpty.toStatement("$n");
    expect(addedFromEmptyText).toContain(
      'IN (SELECT "target_id" FROM "public"."junction_statement_memberships"'
    );
    expect(addedFromEmptyText).toContain('"owner_id" = $2');
    expect(removedFromEmpty.values).toEqual([1, 1, 0, 1]);
  });

  test("keeps compound target exclusion as the negation of the complete tuple set", () => {
    const statement = junctionCompiler(compoundSchema.owner).materialize(
      "membershipDifference",
      {
        parentValue: { tenant: "tenant-1", code: "owner-1" },
        targetValues: [{ region: "eu", serial: 7 }],
        difference: "added",
      }
    );
    const text = statement.toStatement("$n");

    expect(text).toContain("NOT");
    expect(text).toContain('"region" = $5');
    expect(text).toContain('"serial" = $6');
    expect(statement.values).toEqual([1, 1, "tenant-1", "owner-1", "eu", 7, 1]);
  });

  test("updates only connected targets and composes an optional target filter", () => {
    const compiler = junctionCompiler(scalarSchema.owner);
    const allConnected = compiler.materialize("membershipUpdateMany", {
      parentValue: 1,
      data: { label: { set: "all" } },
    });
    const filtered = compiler.materialize("membershipUpdateMany", {
      parentValue: 1,
      where: { enabled: { equals: true } },
      data: { label: { set: "filtered" } },
    });

    const allConnectedText = allConnected.toStatement("$n");
    expect(allConnectedText).toContain(
      'IN (SELECT "target_id" FROM "public"."junction_statement_memberships"'
    );
    expect(allConnectedText).toContain('"owner_id" = $2');
    expect(allConnected.values).toEqual(["all", 1]);
    expect(filtered.toStatement("$n")).toContain("AND");
    expect(filtered.values).toEqual(["filtered", 1, true]);
  });

  test("resolves an insert target through a unique selector subquery", () => {
    const statement = junctionCompiler(scalarSchema.owner).materialize(
      "junctionInsert",
      {
        parentValue: 1,
        targetWhere: { id: 2 },
      }
    );

    expect(statement.toStatement("$n")).toContain("SELECT");
    expect(statement.values).toEqual([1, 2]);
  });
});

describe("coverage low value", () => {
  test("refuses malformed internal junction statement arguments", () => {
    const compiler = junctionCompiler(scalarSchema.owner);

    expect(() =>
      compiler.materialize("membershipRead", {
        parentValue: 1,
        additionalColumns: [sql`1`, "not-sql"],
      })
    ).toThrow("invalid additional column");
    expect(() =>
      compiler.materialize("membershipDifference", {
        parentValue: 1,
        targetValues: [],
        difference: "sideways",
      })
    ).toThrow("no valid direction");
    expect(() =>
      compiler.materialize("junctionInsertMany", { parentValue: 1 })
    ).toThrow("missing 'targetValues'");
    expect(() =>
      compiler.materialize("membershipUpdateMany", { parentValue: 1 })
    ).toThrow("missing 'data'");
    expect(() =>
      compiler.materialize("junctionInsert", { parentValue: 1 })
    ).toThrow("has no target");
    expect(() =>
      junctionCompiler(compoundSchema.owner).materialize("junctionInsert", {
        parentValue: "incomplete",
        targetValue: { region: "eu", serial: 7 },
      })
    ).toThrow("requires one value for every referenced field");
  });
});
