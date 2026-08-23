import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { resolveSchemaOrThrow } from "@schema/validation";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { createSchemaRegistry, parse } from "@validation";
import { nestedRelationDataProjection } from "@validation/relations/nested-data-projection";
import { describe, expect, test } from "vitest";

/**
 * DIRECT witness of `nestedRelationDataProjection`'s ONE decision — exactly
 * which TARGET keys a nested create/update payload may not spell, because the
 * enclosing step already derives them.
 *
 * The decision is read where the projection WRITES it: `v.omit` records its key
 * list in the produced object schema's `options.omit`. That is deliberately not
 * a parse-only reading — a key can be unspellable for an unrelated reason, and
 * a parse-only witness would keep passing while measuring nothing. The
 * consequence is asserted alongside it.
 *
 * §11.3.13 lives here: in each of the four carrier/inverse cardinality cells,
 * nested create and nested update through the inverse omit the EXACT carrier
 * relation key — and nothing else.
 */

type ProjectedSchema = { readonly options?: { readonly omit?: unknown } };

/** The key list this projected schema omits, as the projection recorded it. */
const omittedKeys = (schema: unknown): unknown =>
  (schema as ProjectedSchema).options?.omit;

// =============================================================================
// THE FOUR VARIANT CELLS
// =============================================================================

// A MEMBER-JUNCTION carrier (to-many) may mix its inverses' cardinalities;
// a ROW-HELD carrier (to-one) may not, so it gets its own pair of schemas.
const article = s.model({
  id: s.string().id(),
  gallery: s.toOne(() => owner),
});
const photo = s.model({
  id: s.string().id(),
  galleries: s.toMany(() => owner),
});
const owner = s.model({
  id: s.string().id(),
  items: s.toMany(
    { article: () => article, photo: () => photo },
    { values: { article: "proj.article.v1", photo: "proj.photo.v1" } }
  ),
});
const junctionSchema = { article, photo, owner };

const badge = s.model({
  id: s.string().id(),
  holder: s.toOne(() => rowHolder),
});
const rowHolder = s.model({
  id: s.string().id(),
  mark: s.toOne({ badge: () => badge }, { values: { badge: "proj.badge.v1" } }),
});
const rowOneSchema = { badge, rowHolder };

const sticker = s.model({
  id: s.string().id(),
  holders: s.toMany(() => stickerHolder),
});
const stickerHolder = s.model({
  id: s.string().id(),
  mark: s.toOne(
    { sticker: () => sticker },
    { values: { sticker: "proj.sticker.v1" } }
  ),
});
const rowManySchema = { sticker, stickerHolder };

// =============================================================================
// THE ORDINARY CONTROLS
// =============================================================================

const author = s.model({
  id: s.string().id(),
  books: s.toMany(() => book),
});
const book = s.model({
  id: s.string().id(),
  authorId: s.string(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const ordinarySchema = { author, book };

// =============================================================================

const slotOf = (
  schema: Record<string, AnyModel>,
  model: AnyModel,
  field: string
): ResolvedSlot => {
  const resolved = resolveSchemaOrThrow(schema).get(model)?.get(field);
  if (!resolved) throw new Error(`no resolved slot for ${field}`);
  return resolved;
};

const projectionFor = (
  schema: Record<string, AnyModel>,
  model: AnyModel,
  field: string,
  targetKey: string
) => {
  const registry = createSchemaRegistry(schema);
  const target = () =>
    registry.getModelSchemas(schema[targetKey] as AnyModel) as never;
  return nestedRelationDataProjection(slotOf(schema, model, field), target);
};

describe("the derived keys a nested payload may not spell", () => {
  test.each([
    [
      "a SINGULAR inverse of a member-junction carrier",
      junctionSchema,
      article,
      "gallery",
      "owner",
    ],
    [
      "a PLURAL inverse of a member-junction carrier",
      junctionSchema,
      photo,
      "galleries",
      "owner",
    ],
    [
      "a SINGULAR inverse of a row-held carrier",
      rowOneSchema,
      badge,
      "holder",
      "rowHolder",
    ],
    [
      "a PLURAL inverse of a row-held carrier",
      rowManySchema,
      sticker,
      "holders",
      "stickerHolder",
    ],
  ] as const)(
    "%s omits the EXACT carrier relation key",
    (_label, schema, model, field, targetKey) => {
      const projection = projectionFor(
        schema as Record<string, AnyModel>,
        model,
        field,
        targetKey
      );
      const carrier = targetKey === "owner" ? "items" : "mark";
      expect(omittedKeys(projection.getCreateSchema())).toEqual([carrier]);
      expect(omittedKeys(projection.getUpdateSchema())).toEqual([carrier]);
      // The consequence: the enclosing step already fixes this membership, so a
      // spelled carrier key is a second provenance and is refused as unknown.
      expect(
        parse(projection.getCreateSchema(), { id: "seed", [carrier]: {} })
          .issues
      ).toEqual([{ message: `Unknown key: ${carrier}`, path: [carrier] }]);
      // Scoped to the bound key, never the whole model: the target's own
      // scalars stay spellable.
      expect(
        parse(projection.getCreateSchema(), { id: "kept" }).issues
      ).toBeUndefined();
    }
  );

  test("an inverse of a stored reference omits the exact foreign-key columns", () => {
    const projection = projectionFor(ordinarySchema, author, "books", "book");
    expect(omittedKeys(projection.getCreateSchema())).toEqual(["authorId"]);
    expect(omittedKeys(projection.getUpdateSchema())).toEqual(["authorId"]);
  });

  test("the OWNER of a stored reference omits nothing", () => {
    // `book.authorId` sits on the row spelling the payload, never on the
    // target, so a nested `author: { create }` has no derived key to hide.
    const projection = projectionFor(ordinarySchema, book, "author", "author");
    expect(omittedKeys(projection.getCreateSchema())).toEqual([]);
    expect(omittedKeys(projection.getUpdateSchema())).toEqual([]);
  });

  test("a variant CARRIER omits nothing", () => {
    // Asked from the carrier itself, the membership is this row's own.
    const projection = projectionFor(junctionSchema, owner, "items", "article");
    expect(omittedKeys(projection.getCreateSchema())).toEqual([]);
  });

  test("the two upsert arms un-omit on opposite sides", () => {
    // A stored reference: the CREATE-root arm re-enters, because the engine
    // absorbs an agreeing owned foreign key there.
    const stored = projectionFor(ordinarySchema, author, "books", "book");
    expect(omittedKeys(stored.getCreateUpsertUpdateSchema())).toBeUndefined();
    expect(omittedKeys(stored.getSelectedUpsertUpdateSchema())).toEqual([
      "authorId",
    ]);

    // A variant carrier: the SELECTED arm re-enters, because that arm has row
    // continuity back to the exact incoming parent.
    const variant = projectionFor(junctionSchema, article, "gallery", "owner");
    expect(
      omittedKeys(variant.getSelectedUpsertUpdateSchema())
    ).toBeUndefined();
    expect(omittedKeys(variant.getCreateUpsertUpdateSchema())).toEqual([
      "items",
    ]);
  });
});
