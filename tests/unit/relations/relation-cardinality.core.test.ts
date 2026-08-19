import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { hydrateSchemaNames, s } from "@schema";
import {
  polymorphicCardinality,
  relationCardinality,
} from "@schema/relation/cardinality";
import { describe, expect, test } from "vitest";

/**
 * THE ONE READING of "does this edge address many rows".
 *
 * Four consumers derived it from `RelationType` themselves — the query scope's
 * `RelationInfo`, the result parser's array-vs-object decision, the validation
 * layer's to-many/to-one schema choice and the order-by builder's to-one
 * restriction. This pins the function they now share, on all four relation types,
 * and pins that the query scope really reads it rather than keeping its own copy.
 */

const target = s.model({ id: s.string().id() });

const stateOf = (relation: { "~": { state: unknown } }) =>
  relation["~"].state as Parameters<typeof relationCardinality>[0];

describe("relationCardinality", () => {
  test("answers MANY for the two many-sided edges and ONE for the others", () => {
    expect(relationCardinality(stateOf(s.oneToMany(() => target)))).toBe(
      "many"
    );
    expect(relationCardinality(stateOf(s.manyToMany(() => target)))).toBe(
      "many"
    );
    expect(relationCardinality(stateOf(s.oneToOne(() => target)))).toBe("one");
    expect(relationCardinality(stateOf(s.manyToOne(() => target)))).toBe("one");
  });

  test("optionality is a different fact and does not move it", () => {
    // A to-one may be empty and is still one row; nothing here reads `.optional()`.
    expect(
      relationCardinality(stateOf(s.oneToOne(() => target).optional()))
    ).toBe("one");
  });

  test("the query scope's RelationInfo reports this reading, not its own", () => {
    const child = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .manyToOne(() => parent)
        .fields("parentId")
        .references("id"),
    });
    const parent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => child),
    });
    hydrateSchemaNames({ parent, child });

    const scope = createQueryScope(new PostgresAdapter(), parent);
    expect(getRelationInfo(scope, "children")?.cardinality).toBe("many");

    const childScope = createQueryScope(new PostgresAdapter(), child);
    expect(getRelationInfo(childScope, "parent")?.cardinality).toBe("one");
  });
});

/**
 * The polymorphic half of the same reading.
 *
 * A carrier does not encode MANY vs ONE in its `type`, so the factory the
 * declaration was spelled with is the whole fact. `create` requiredness already
 * branches on it (`validation/model/core/create.ts`) and Package C adds the
 * result wrapper, which is why this reader exists at all.
 */
describe("polymorphicCardinality", () => {
  test("answers the factory the declaration was spelled with", () => {
    const targets = { target: () => target };

    expect(polymorphicCardinality(s.polymorphicToOne(targets)["~"].state)).toBe(
      "one"
    );
    expect(
      polymorphicCardinality(s.polymorphicToMany(targets)["~"].state)
    ).toBe("many");
  });
});
