import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { lookupRelation } from "@query-engine/context/query-scope";
import { s } from "@schema";
import {
  canonicalTargetKey,
  countDistinctTargets,
  groupLinkTargets,
  linkGroupSelector,
} from "@src/query-engine/write-engine/link-target-groups";
import {
  clearableForeignKeyFields,
  requiredForeignKeyFields,
} from "@src/query-engine/write-engine/relation-nullability";
import {
  rowKeysEqual,
  rowKeyToken,
  sortCapturedRowKeys,
} from "@src/query-engine/write-engine/target-projection";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const owner = s
    .model({
      tenant: s.string(),
      code: s.string(),
      children: s.toMany(() => child),
    })
    .id(["tenant", "code"])
    .map("relation_coverage_owner");
  const child = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      ownerTenant: s.string(),
      ownerCode: s.string().nullable(),
      lookupTenant: s.string(),
      lookupCode: s.string(),
      owner: s
        .toOne(() => owner)
        .fields("ownerTenant", "ownerCode")
        .references("tenant", "code"),
    })
    .unique(["lookupTenant", "lookupCode"])
    .map("relation_coverage_child");
  return { child, owner };
})();

prepareSchema(schema);

const adapter = new PostgresAdapter();
const childScope = scopeFor(adapter, schema.child);
const ownerScope = scopeFor(adapter, schema.owner);

describe("relation target grouping coverage", () => {
  test("groups only identical primitive selector shapes and preserves group order", () => {
    const targets = [
      { id: 1 },
      { slug: "two" },
      { id: 3 },
      { id: 4, ownerTenant: "tenant-a" },
      { id: 5 },
    ];

    expect(groupLinkTargets(childScope, targets)).toEqual([
      [{ id: 1 }, { id: 3 }, { id: 5 }],
      [{ slug: "two" }],
      [{ id: 4, ownerTenant: "tenant-a" }],
    ]);
  });

  test("builds one IN selector for scalar keys and ordered equalities for compounds", () => {
    expect(linkGroupSelector(childScope, [{ id: 1 }, { id: 2 }])).toEqual({
      id: { in: [1, 2] },
    });
    expect(
      linkGroupSelector(childScope, [
        {
          lookupTenant_lookupCode: {
            lookupTenant: "tenant-a",
            lookupCode: "one",
          },
        },
        {
          lookupTenant_lookupCode: {
            lookupTenant: "tenant-b",
            lookupCode: "two",
          },
        },
      ])
    ).toEqual({
      OR: [
        {
          AND: [
            { lookupTenant: { equals: "tenant-a" } },
            { lookupCode: { equals: "one" } },
          ],
        },
        {
          AND: [
            { lookupTenant: { equals: "tenant-b" } },
            { lookupCode: { equals: "two" } },
          ],
        },
      ],
    });
  });

  test("counts repeated typed keys once without conflating equal text of another type", () => {
    expect(countDistinctTargets(childScope, [{ id: 1 }, { id: 1 }])).toBe(1);
    expect(countDistinctTargets(childScope, [{ id: 1 }, { id: 2 }])).toBe(2);
    expect(canonicalTargetKey([{ fieldName: "id", value: 1 }])).not.toBe(
      canonicalTargetKey([{ fieldName: "slug", value: "1" }])
    );
  });
});

describe("relation nullability coverage", () => {
  test("derives clearable and retained members from one mixed compound edge", () => {
    const relationRef = lookupRelation(ownerScope, "children");
    if (!relationRef) throw new Error("expected owner.children relation");
    const relation = bindRelation(ownerScope, relationRef);
    if (relation.position !== "childHeld") {
      throw new Error("expected a child-held relation");
    }

    expect(clearableForeignKeyFields(relation)).toEqual(["ownerCode"]);
    expect(requiredForeignKeyFields(relation)).toEqual(["ownerTenant"]);
  });
});

describe("coverage low value", () => {
  test("row-key registry encoding stays total over defensive internal values", () => {
    const values = [
      false,
      true,
      0n,
      1n,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      -0,
      0,
      Number.POSITIVE_INFINITY,
      "0",
      new Date(0),
      new Uint8Array([0, 255]),
    ];
    const tokens = values.map((id) => rowKeyToken(schema.child, { id }));

    expect(new Set(tokens).size).toBe(values.length);
    for (const id of [null, undefined]) {
      expect(() => rowKeyToken(schema.child, { id })).toThrow(
        "primary key field 'id' is missing"
      );
    }
  });

  test("the defensive row-key comparator is total over heterogeneous values", () => {
    const bytesBacking = new Uint8Array([99, 1, 2, 99]);
    const bytesWindow = new Uint8Array(bytesBacking.buffer, 1, 2);
    const rows = [
      { id: { toString: () => "z" }, name: "other" },
      { id: new Uint8Array([1, 2, 3]), name: "bytes-long" },
      { id: bytesWindow, name: "bytes-window" },
      { id: new Date(10), name: "date-late" },
      { id: new Date(0), name: "date-early" },
      { id: "b", name: "string-b" },
      { id: "a", name: "string-a" },
      { id: 2n, name: "bigint-two" },
      { id: 1, name: "number-one" },
      { id: true, name: "true" },
      { id: false, name: "false" },
      { id: undefined, name: "undefined" },
      { id: null, name: "null" },
    ];

    expect(sortCapturedRowKeys(["id"], rows).map((row) => row.name)).toEqual([
      "undefined",
      "null",
      "false",
      "true",
      "number-one",
      "bigint-two",
      "string-a",
      "string-b",
      "date-early",
      "date-late",
      "bytes-window",
      "bytes-long",
      "other",
    ]);
  });

  test("defensive equality compares date instants and visible byte windows", () => {
    const backing = new Uint8Array([7, 1, 2, 8]);
    expect(
      rowKeysEqual(
        schema.child,
        { id: new Date("2026-01-01T00:00:00.000Z") },
        { id: new Date("2026-01-01T00:00:00.000Z") }
      )
    ).toBe(true);
    expect(
      rowKeysEqual(
        schema.child,
        { id: new Uint8Array(backing.buffer, 1, 2) },
        { id: new Uint8Array([1, 2]) }
      )
    ).toBe(true);
  });
});
