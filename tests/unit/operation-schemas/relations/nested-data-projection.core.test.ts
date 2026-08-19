import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { nestedRelationDataProjection } from "@validation/relations/nested-data-projection";
import { describe, expect, test } from "vitest";

/**
 * DIRECT witness of `nestedRelationDataProjection`'s ONE decision — whether an
 * edge omits the TARGET's inverse relation key from nested create/update data.
 *
 * The projection asks `getCompatiblePolymorphicInverseBinding` and nothing
 * else, so B3's retained-shape tightening moves the answer for exactly two
 * spellings. Every other test that touches this file reaches it through a verb
 * factory, where an omission and a mere absence look alike.
 *
 * The decision is read where the projection WRITES it — `v.omit` records its
 * key list in the produced object schema's `options.omit`. That is deliberately
 * not a parse-behaviour reading: once the operation-schema families are omitted
 * for collection groups, the owner's `items` key is unspellable for an
 * unrelated reason, and a parse-only witness would keep passing while measuring
 * nothing. The consequence is asserted alongside it for the bound shapes.
 */

type ProjectedSchema = { readonly options?: { readonly omit?: unknown } };

/** The key list this projected schema omits, as the projection recorded it. */
const omittedKeys = (schema: unknown): unknown =>
  (schema as ProjectedSchema).options?.omit;

describe("nestedRelationDataProjection over a collection group", () => {
  // The two Package C shapes plus both RETAINED shapes, all pointed at the same
  // collection group, so the only variable is the asking relation's type.
  const article = s.model({
    id: s.string().id(),
    gallery: s.manyToOne(() => owner).optional(),
  });
  const photo = s.model({
    id: s.string().id(),
    galleries: s.manyToMany(() => owner),
  });
  const catalog = s.model({
    id: s.string().id(),
    owners: s.oneToMany(() => owner),
  });
  const twin = s.model({
    id: s.string().id(),
    solo: s.oneToOne(() => owner).optional(),
  });
  const owner = s.model({
    id: s.string().id(),
    items: s.polymorphicToMany(
      {
        article: () => article,
        photo: () => photo,
        catalog: () => catalog,
        twin: () => twin,
      },
      {
        values: {
          article: "proj.article.v1",
          photo: "proj.photo.v1",
          catalog: "proj.catalog.v1",
          twin: "proj.twin.v1",
        },
      }
    ),
  });

  // `registry.proxy` keeps each model's schemas precisely typed, which is what
  // `SchemaGetter<S>` demands — the erased `getModelSchemas(model)` view would
  // need the same cast production makes internally, and would prove less.
  const registry = createSchemaRegistry({
    article,
    photo,
    catalog,
    twin,
    owner,
  });
  const ownerSchemas = () => registry.proxy.owner;

  const projections = {
    manyToOne: nestedRelationDataProjection(
      article["~"].state.relations.gallery["~"].state,
      article,
      ownerSchemas
    ),
    manyToMany: nestedRelationDataProjection(
      photo["~"].state.relations.galleries["~"].state,
      photo,
      ownerSchemas
    ),
    oneToMany: nestedRelationDataProjection(
      catalog["~"].state.relations.owners["~"].state,
      catalog,
      ownerSchemas
    ),
    oneToOne: nestedRelationDataProjection(
      twin["~"].state.relations.solo["~"].state,
      twin,
      ownerSchemas
    ),
  };

  test.each([
    ["a fields-less manyToOne", projections.manyToOne],
    ["a fields-less manyToMany", projections.manyToMany],
  ])("%s binds the group and omits the owner's relation key", (_label, projection) => {
    expect(omittedKeys(projection.getCreateSchema())).toEqual(["items"]);
    expect(omittedKeys(projection.getUpdateSchema())).toEqual(["items"]);
    // The consequence: the enclosing step already fixes this membership, so a
    // spelled `items` is a second provenance and is refused as unknown.
    expect(
      parse(projection.getCreateSchema(), { id: "seed", items: {} }).issues
    ).toEqual([{ message: "Unknown key: items", path: ["items"] }]);
  });

  test.each([
    ["a retained oneToMany", projections.oneToMany],
    ["a retained fields-less oneToOne", projections.oneToOne],
  ])("%s over the same group omits nothing", (_label, projection) => {
    // B3's tightening: a row-held shape no longer binds a collection group, so
    // this edge falls to its ORDINARY arm — where `getInverseRelationMap` finds
    // no fields-bearing back-reference, and the projection omits nothing.
    // BEFORE the tightening these edges claimed the binding and omitted
    // `items`, withholding a key whose membership they do not in fact fix.
    expect(omittedKeys(projection.getCreateSchema())).toBeUndefined();
    expect(omittedKeys(projection.getUpdateSchema())).toBeUndefined();
  });

  test("the omission is scoped to the bound key, not the whole model", () => {
    // Guards against an omission that quietly strips more than it owns: the
    // owner's own scalars stay spellable on a bound edge.
    expect(
      parse(projections.manyToMany.getCreateSchema(), { id: "kept" }).issues
    ).toBeUndefined();
  });
});
