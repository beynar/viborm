import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  type PolymorphicStorageValue,
  polymorphicStorageMembers,
} from "@query-engine/builders/polymorphic-mutation";
import type { QueryScope } from "@query-engine/types";
import { s } from "@schema";
import type { ResolvedVariantRowEdge } from "@schema/validation/relation-resolution";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { beforeAll, describe, expect, test } from "vitest";

const article = s.model({ id: s.string().id() });
const clip = s.model({ id: s.string().id() });

function carrier(index: number) {
  return s
    .toOne(
      { article: () => article, clip: () => clip },
      {
        values: {
          article: `wide.article.${index}`,
          clip: `wide.clip.${index}`,
        },
      }
    )
    .optional();
}

const carrierFields = Object.fromEntries(
  Array.from({ length: 64 }, (_, index) => [`carrier${index}`, carrier(index)])
);
const wideOwner = s.model({ id: s.string().id(), ...carrierFields });
const schema = { article, clip, wideOwner };

function rowCarrier(scope: QueryScope, field: string): ResolvedVariantRowEdge {
  const resolved = scope.relations.get(scope.model)?.get(field);
  if (
    !resolved ||
    resolved.edge.kind !== "variantRowCarrier" ||
    resolved.edge.carrier !== resolved.slot
  ) {
    throw new Error(`Expected '${field}' to be a variant row carrier`);
  }
  return resolved.edge;
}

function linkedValue(
  edge: ResolvedVariantRowEdge,
  id: string
): PolymorphicStorageValue<string> {
  const member = edge.members[0];
  return {
    kind: "linked",
    carrier: edge.carrier,
    storage: edge.storage,
    storedType: member.entry.storedValue,
    referencedField: member.referencedField,
    id,
  };
}

beforeAll(() => {
  prepareSchema(schema);
});

describe("variant row-storage member grouping", () => {
  test("emits several assigned carriers in model declaration order", () => {
    const scope = scopeFor(new SQLiteAdapter(), wideOwner);
    const carrier2 = rowCarrier(scope, "carrier2");
    const carrier8 = rowCarrier(scope, "carrier8");
    const carrier31 = rowCarrier(scope, "carrier31");
    const carrier47 = rowCarrier(scope, "carrier47");
    const values: PolymorphicStorageValue<string>[] = [
      linkedValue(carrier31, "id-31"),
      {
        kind: "empty",
        carrier: carrier2.carrier,
        storage: carrier2.storage,
      },
      linkedValue(carrier47, "id-47"),
      linkedValue(carrier8, "id-8"),
    ];

    expect(
      polymorphicStorageMembers(scope, values).map(({ column, value }) => [
        column.name,
        value,
      ])
    ).toEqual([
      [carrier2.storage.typeColumn.name, null],
      [carrier2.storage.idColumn.name, null],
      [carrier8.storage.typeColumn.name, carrier8.members[0].entry.storedValue],
      [carrier8.storage.idColumn.name, "id-8"],
      [
        carrier31.storage.typeColumn.name,
        carrier31.members[0].entry.storedValue,
      ],
      [carrier31.storage.idColumn.name, "id-31"],
      [
        carrier47.storage.typeColumn.name,
        carrier47.members[0].entry.storedValue,
      ],
      [carrier47.storage.idColumn.name, "id-47"],
    ]);
  });

  test("reads each assignment carrier once on a wide model", () => {
    const scope = scopeFor(new SQLiteAdapter(), wideOwner);
    const assignedFields = [
      "carrier1",
      "carrier5",
      "carrier9",
      "carrier14",
      "carrier20",
      "carrier27",
      "carrier33",
      "carrier38",
      "carrier44",
      "carrier51",
      "carrier57",
      "carrier63",
    ];
    let carrierReads = 0;
    const values = assignedFields.map((field, index) => {
      const edge = rowCarrier(scope, field);
      const member = edge.members[0];
      return {
        kind: "linked",
        get carrier() {
          carrierReads += 1;
          return edge.carrier;
        },
        storage: edge.storage,
        storedType: member.entry.storedValue,
        referencedField: member.referencedField,
        id: `id-${index}`,
      } satisfies PolymorphicStorageValue<string>;
    });

    expect(scope.relations.get(wideOwner)?.size).toBe(64);
    expect(polymorphicStorageMembers(scope, values)).toHaveLength(24);
    expect(carrierReads).toBe(values.length);
  });
});
