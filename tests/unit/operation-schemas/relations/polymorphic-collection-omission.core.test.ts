import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE E — WHERE THE COLLECTION BOUNDARY NOW SITS.
 *
 * B3 built NO families for a collection group, so `v.object`'s strictness
 * closed all six surfaces with one omission. C made the READ families real and
 * left the write families as `v.refused` entries. D made `create` / `update` /
 * `upsert` real. E takes the last one:
 *
 *   - the ROOT-`createMany` ROW now mounts the SAME collection `create` family,
 *     because the row is relation-BEARING and `routing.ts` sends the whole call
 *     to the record series. The pin below flipped its verdict, and the sentence
 *     it used to assert has no owner left.
 *
 * Every write surface on a collection group is now open, and the file's value
 * shifts from "which surfaces are closed" to "each surface takes the family it
 * is supposed to take, and no wider one".
 *
 * What each pin is worth is stated per test: two of these write surfaces were
 * SILENT before B3, and silence in a write path is the failure mode this whole
 * decision exists to remove.
 */

const article = s.model({
  id: s.string().id(),
  gallery: s.manyToOne(() => owner).optional(),
});
const photo = s.model({
  id: s.string().id(),
  galleries: s.manyToMany(() => owner),
});
const owner = s.model({
  id: s.string().id(),
  title: s.string(),
  // A COLLECTION group beside a toOne group on the same model: every pin below
  // asserts the collection key is refused AND the singular key still works, so
  // an omission that over-reached would be visible immediately.
  items: s.polymorphicToMany(
    { article: () => article, photo: () => photo },
    { values: { article: "omit.article.v1", photo: "omit.photo.v1" } }
  ),
  feature: s
    .polymorphicToOne(
      { article: () => article, photo: () => photo },
      { values: { article: "feat.article.v1", photo: "feat.photo.v1" } }
    )
    .optional(),
});

const schema = { article, photo, owner };
hydrateSchemaNames(schema);
const registry = createSchemaRegistry(schema);
const core = () => registry.proxy.owner.core;

describe("collection polymorphic reads and writes land on every surface", () => {
  test("the registry record carries BOTH groups", () => {
    // The single change every pin below descends from: a collection group now
    // builds eight families instead of none, in declaration order.
    expect(Object.keys(registry.proxy.owner.polymorphic)).toEqual([
      "items",
      "feature",
    ]);
  });

  test("where accepts a collection quantifier filter", () => {
    expect(
      parse(core().where, {
        items: { some: { type: "article", is: { id: "a" } } },
      }).issues
    ).toBeUndefined();
    // The singular group's filter is untouched.
    expect(
      parse(core().where, { feature: { type: "article", is: { id: "a" } } })
        .issues
    ).toBeUndefined();
    // A collection has NO null-presence arm — an empty collection is `[]`, not
    // `null`, so `is: null` would be a second spelling of emptiness.
    expect(parse(core().where, { items: { is: null } }).issues).toBeDefined();
  });

  test("select accepts a collection projection key", () => {
    expect(parse(core().select, { items: true }).issues).toBeUndefined();
    expect(
      parse(core().select, {
        items: { only: ["article"], variants: { article: true } },
      }).issues
    ).toBeUndefined();
    expect(parse(core().select, { feature: true }).issues).toBeUndefined();
  });

  test("include accepts a collection projection key", () => {
    expect(parse(core().include, { items: true }).issues).toBeUndefined();
    expect(
      parse(core().include, { items: { variants: { photo: true } } }).issues
    ).toBeUndefined();
    expect(parse(core().include, { feature: true }).issues).toBeUndefined();
  });

  test("create ACCEPTS a collection data key, in the tagged spelling", () => {
    // THE FLIP. Before C this key parsed and then vanished: the
    // relation-mutation parser put a toMany key in NEITHER `scalarData` NOR
    // `polymorphicPayloads` and fell through its `continue`. C refused it; D
    // makes it real, and the parser now carries it as its own arm — so the
    // silent-discard hazard is closed by construction rather than by refusal.
    expect(
      parse(core().create, {
        id: "o1",
        title: "t",
        items: { create: [{ type: "article", data: { id: "a1" } }] },
      }).issues
    ).toBeUndefined();
    // The UNTAGGED B3-era spelling is still refused — the discriminator lives
    // INSIDE each verb, so a bare variant-keyed object is not this grammar.
    expect(
      parse(core().create, {
        id: "o1",
        title: "t",
        items: { create: [{ article: { id: "a1" } }] },
      }).issues
    ).toBeDefined();
    expect(
      parse(core().create, {
        id: "o1",
        title: "t",
        feature: { connect: { type: "article", where: { id: "a1" } } },
      }).issues
    ).toBeUndefined();
  });

  test("the create bag carries NO upsert, unlike the ordinary to-many one", () => {
    // The pinned asymmetry (§9.2): a collection `upsert` scopes its found arm to
    // THIS owner's membership, and a fresh owner has no membership to scope to.
    // The ordinary `ToManyCreateSchema` does carry a Prisma-superset `upsert`
    // with global-adopt semantics; this deliberately does not.
    expect(
      parse(core().create, {
        id: "o1",
        title: "t",
        items: {
          upsert: [
            {
              type: "article",
              where: { id: "a1" },
              create: { id: "a1" },
              update: {},
            },
          ],
        },
      }).issues
    ).toBeDefined();
    // …while the UPDATE bag accepts exactly that payload.
    expect(
      parse(core().update, {
        items: {
          upsert: [
            {
              type: "article",
              where: { id: "a1" },
              create: { id: "a1" },
              update: {},
            },
          ],
        },
      }).issues
    ).toBeUndefined();
  });

  test("update ACCEPTS a collection data key, and several verbs coexist", () => {
    expect(parse(core().update, { items: { set: [] } }).issues).toBeUndefined();
    // NOT the to-one envelope: the collection bag is a plain object, so it does
    // not inherit `exactlyOne`. Two verbs at once is a legal collection payload
    // and an EMPTY bag is inert rather than malformed.
    expect(
      parse(core().update, {
        items: {
          connect: [{ type: "article", where: { id: "a1" } }],
          disconnect: [{ type: "photo", where: { id: "p1" } }],
        },
      }).issues
    ).toBeUndefined();
    expect(parse(core().update, { items: {} }).issues).toBeUndefined();
    expect(
      parse(core().update, {
        feature: { connect: { type: "article", where: { id: "a1" } } },
      }).issues
    ).toBeUndefined();
  });

  test("createMany rows ACCEPT a collection key, in the same tagged spelling create takes", () => {
    // THE FLIP, and the last one this file had left. The bulk bypass it used to
    // close is now closed by the ROUTE: `routing.ts`'s `relationBearingRow` reads
    // the collection half of the polymorphic set, so such a row never reaches
    // `CreateManyOperation`'s grouped INSERT at all — the whole call goes to the
    // relation-bearing record series, where the member junction inserts follow
    // the owner root.
    expect(
      parse(core().bulkCreate, {
        id: "o1",
        title: "t",
        items: { connect: [{ type: "article", where: { id: "a1" } }] },
      }).issues
    ).toBeUndefined();
    // It is the COLLECTION family, not the to-one connect-only union: a tagged
    // `create` verb exists only in the former.
    expect(
      parse(core().bulkCreate, {
        id: "o1",
        title: "t",
        items: { create: [{ type: "article", data: { id: "a1" } }] },
      }).issues
    ).toBeUndefined();
    // …while the direct TO-ONE key in a bulk row keeps its NARROWER union: its
    // grouped cross-row probe route stores private owner columns on the row and
    // cannot express a nested create. That asymmetry is what `relationBearingRow`
    // dispatches on, so it is pinned here beside the widened half.
    expect(
      parse(core().bulkCreate, {
        id: "o1",
        title: "t",
        feature: { connect: { type: "article", where: { id: "a1" } } },
      }).issues
    ).toBeUndefined();
    expect(
      parse(core().bulkCreate, {
        id: "o1",
        title: "t",
        feature: { create: { type: "article", data: { id: "a1" } } },
      }).issues
    ).toBeDefined();
  });

  test("upsert ACCEPTS a collection key through BOTH its data halves", () => {
    // `upsert` owns no data schema of its own — it composes `create` and
    // `update`. Pinning it explicitly is what keeps the transitivity a measured
    // fact rather than an assumption about how the args schema is assembled:
    // both halves flipped, and neither was edited to make it happen.
    const upsert = registry.proxy.owner.args.upsert;
    expect(
      parse(upsert, {
        where: { id: "o1" },
        create: { id: "o1", title: "t", items: { connect: [] } },
        update: { title: "t" },
      }).issues
    ).toBeUndefined();
    expect(
      parse(upsert, {
        where: { id: "o1" },
        create: { id: "o1", title: "t" },
        update: { items: { set: [] } },
      }).issues
    ).toBeUndefined();
  });

  test("a required collection group adds no create requirement", () => {
    // The requirement derivation reads `polymorphicCardinality` and builds
    // groups for `"one"` only, so a NON-optional collection never demands a
    // key the schema does not offer. Without that, every create of this model
    // would be unsatisfiable.
    //
    // BYTE-UNCHANGED THROUGH C **AND D**, and that is the point: a `v.refused`
    // is OPTIONAL under `partial: true`, and so is the REAL create bag D put in
    // its place (`{ optional: true }`). If either had turned the key into a
    // requirement, every create of this model would be unsatisfiable — the
    // exact failure D1 had to avoid, and the reason this pin outlives the
    // refusal it was written beside.
    expect(
      parse(core().create, { id: "o1", title: "t" }).issues
    ).toBeUndefined();
  });

  test("orderBy and _count exist for the collection and are refused for the slot", () => {
    // The other half of D1's "identical family key set": `orderBy` and
    // `countFilter` are built for BOTH cardinalities, so `v.fromObject` stays
    // total on a model whose only polymorphic relation is a to-one slot.
    expect(
      parse(core().orderBy, { items: { _count: "desc" } }).issues
    ).toBeUndefined();
    expect(
      parse(core().orderBy, { feature: { _count: "desc" } }).issues?.[0]
        ?.message
    ).toContain("cannot be ordered on");

    expect(
      parse(core().select, { _count: { select: { items: true } } }).issues
    ).toBeUndefined();
    expect(
      parse(core().select, {
        _count: { select: { items: { where: { type: "article" } } } },
      }).issues
    ).toBeUndefined();
    expect(
      parse(core().select, { _count: { select: { feature: true } } })
        .issues?.[0]?.message
    ).toContain("no collection to count");
  });
});
