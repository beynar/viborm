import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * THE COLLECTION WRITE GRAMMAR (plan §9.1), surface by surface.
 *
 * The sibling files pin the collection's FILTER, SELECTION and OMISSION
 * surfaces; this one pins the eleven verbs and the two context bags Package D
 * added, and it is deliberately separate from the omission file: that file's job
 * is where the boundary SITS, this one's is what the grammar SAYS once you are
 * inside it.
 */

const article = s.model({
  id: s.string().id(),
  title: s.string(),
  views: s.int(),
});
const photo = s.model({ id: s.string().id(), caption: s.string() });
const owner = s.model({
  id: s.string().id(),
  title: s.string(),
  items: s.polymorphicToMany(
    { article: () => article, photo: () => photo },
    { values: { article: "cm.article.v1", photo: "cm.photo.v1" } }
  ),
});

const schema = { article, photo, owner };
hydrateSchemaNames(schema);
const registry = createSchemaRegistry(schema);
const core = () => registry.proxy.owner.core;

const accepts = (family: "create" | "update", items: unknown): boolean => {
  const payload =
    family === "create" ? { id: "o1", title: "t", items } : { items };
  return parse(core()[family], payload).issues === undefined;
};

describe("the tagged collection verb grammar", () => {
  test("every verb takes a SINGLE item or an array of them", () => {
    // `singleOrArray` on every verb, `createMany` INCLUDED — a mixed-variant
    // call needs several groups, and the plan's own example spells the verb as a
    // list. This is a deliberate divergence from the ordinary nested
    // `createMany`, which is a bare object.
    expect(
      accepts("update", { connect: { type: "photo", where: { id: "p" } } })
    ).toBe(true);
    expect(
      accepts("update", { connect: [{ type: "photo", where: { id: "p" } }] })
    ).toBe(true);
    expect(
      accepts("update", {
        createMany: { type: "photo", data: [{ id: "p", caption: "c" }] },
      })
    ).toBe(true);
    expect(
      accepts("update", {
        createMany: [
          { type: "photo", data: [{ id: "p", caption: "c" }] },
          { type: "article", data: [{ id: "a", title: "t", views: 1 }] },
        ],
      })
    ).toBe(true);
  });

  test("the discriminator and its payload CORRELATE, as a free property of the union", () => {
    // No cross-field check anywhere: `article`'s `where` is the article's
    // `whereUnique`, and a photo-shaped selector under `type: "article"` matches
    // no member of the union.
    expect(
      accepts("update", {
        update: [{ type: "article", where: { id: "a" }, data: { views: 2 } }],
      })
    ).toBe(true);
    expect(
      accepts("update", {
        update: [
          // `caption` belongs to `photo`, not `article`.
          { type: "article", where: { id: "a" }, data: { caption: "x" } },
        ],
      })
    ).toBe(false);
    expect(accepts("update", { connect: [{ where: { id: "a" } }] })).toBe(
      false
    );
  });

  test("the bag does NOT inherit the to-one envelope: several verbs coexist", () => {
    // Reaching for `toOneMutationSchema` would import `exactlyOne`, which
    // refuses zero AND two active keys. A collection is exactly the shape where
    // several verbs legitimately coexist and an empty bag is inert.
    expect(
      accepts("update", {
        connect: [{ type: "photo", where: { id: "p" } }],
        disconnect: [{ type: "article", where: { id: "a" } }],
        deleteMany: [{ type: "photo", where: { caption: { equals: "x" } } }],
      })
    ).toBe(true);
    expect(accepts("update", {})).toBe(true);
    expect(accepts("create", {})).toBe(true);
  });

  test("the CREATE bag offers four supply verbs and nothing else", () => {
    for (const verb of ["create", "createMany", "connect", "connectOrCreate"]) {
      expect(
        accepts("create", {
          [verb]:
            verb === "create"
              ? [{ type: "photo", data: { id: "p", caption: "c" } }]
              : verb === "createMany"
                ? [{ type: "photo", data: [{ id: "p", caption: "c" }] }]
                : verb === "connect"
                  ? [{ type: "photo", where: { id: "p" } }]
                  : [
                      {
                        type: "photo",
                        where: { id: "p" },
                        create: { id: "p", caption: "c" },
                      },
                    ],
        })
      ).toBe(true);
    }
    // The seven modify/remove verbs belong to a LOCATED owner.
    for (const verb of [
      "set",
      "disconnect",
      "delete",
      "deleteMany",
      "update",
      "updateMany",
      "upsert",
    ]) {
      expect(accepts("create", { [verb]: [] })).toBe(false);
    }
  });

  test("NO `upsert` in the create bag — the pinned asymmetry", () => {
    // The ordinary `ToManyCreateSchema` carries a Prisma-superset `upsert` with
    // GLOBAL-lookup adopt semantics. The collection omits it because §9.2 gives
    // its `upsert` UPDATE-context semantics — the found arm is scoped to THIS
    // owner's membership — and a fresh owner has no membership to scope to.
    const upsert = [
      {
        type: "photo" as const,
        where: { id: "p" },
        create: { id: "p", caption: "c" },
        update: { caption: "c2" },
      },
    ];
    expect(accepts("create", { upsert })).toBe(false);
    expect(accepts("update", { upsert })).toBe(true);
  });

  test("`update` and `upsert` and `delete` take the EXTENDED unique selector", () => {
    // Exactly where the ordinary to-many operation addresses its member, and
    // deliberately NOT the to-one polymorphic reading where `where` merely
    // filters the one connected record — a slot already names its target, a
    // collection member does not.
    expect(
      accepts("update", {
        delete: [{ type: "article", where: { id: "a", views: { gt: 1 } } }],
      })
    ).toBe(true);
    // `where` is MANDATORY on `update`; the to-one family makes it optional.
    expect(
      accepts("update", { update: [{ type: "article", data: { views: 2 } }] })
    ).toBe(false);
  });

  test("`updateMany` and `deleteMany` take the target's own filter", () => {
    expect(
      accepts("update", {
        updateMany: [{ type: "article", data: { views: 0 } }],
      })
    ).toBe(true);
    expect(
      accepts("update", {
        updateMany: [
          { type: "article", where: { views: { gt: 5 } }, data: { views: 0 } },
        ],
      })
    ).toBe(true);
    expect(
      accepts("update", {
        deleteMany: [{ type: "article", where: { views: { gt: 5 } } }],
      })
    ).toBe(true);
  });

  test("`disconnect` is UNCONDITIONAL and never spelled as `true`", () => {
    // A member junction row always clears — the row goes, no column is nulled —
    // so unlike the ordinary to-many factory this entry asks no clearability
    // question. And `set: []` is the clear-all spelling, so `disconnect: true`
    // is not part of this grammar at all: the junction estate's
    // `m2mDisconnectRequiresSelector` refusal stays unreachable from here.
    expect(
      accepts("update", { disconnect: [{ type: "photo", where: { id: "p" } }] })
    ).toBe(true);
    expect(accepts("update", { disconnect: true })).toBe(false);
    // `set` takes the same tagged unique selector, and `set: []` — the clear-all
    // spelling — is the arity-zero case of exactly that verb, not a second one.
    expect(
      accepts("update", { set: [{ type: "photo", where: { id: "p" } }] })
    ).toBe(true);
    expect(accepts("update", { set: [] })).toBe(true);
    expect(accepts("update", { set: [{ type: "photo" }] })).toBe(false);
  });

  test("`createMany` groups carry their own optional `skipDuplicates`", () => {
    expect(
      accepts("update", {
        createMany: [
          {
            type: "photo",
            data: [{ id: "p", caption: "c" }],
            skipDuplicates: true,
          },
          { type: "photo", data: [{ id: "q", caption: "c" }] },
        ],
      })
    ).toBe(true);
    // `data` is required; a group with only a discriminator says nothing.
    expect(accepts("update", { createMany: [{ type: "photo" }] })).toBe(false);
  });

  test("an unconfigured variant is refused by the union itself", () => {
    expect(
      accepts("update", { connect: [{ type: "audio", where: { id: "x" } }] })
    ).toBe(false);
  });

  test("a misspelled verb is refused by the bag, in both contexts", () => {
    // THE RUNTIME HALF OF A COMPILE-TIME BOUNDARY, and the reason this row
    // exists rather than resting on the strictness the rows above already
    // exercise. `data`/`create`/`update` are on `ClauseGuard`'s NOT-GUARDED
    // list in `src/client/types.ts` — reaching for a write clause's key set
    // expands the recursive nested-write union, six estate sites turn TS2589
    // and the type-check goes to 172s — so `items: { connect: […], connct: […] }`
    // COMPILES. That is pinned as such in
    // `tests/types/client/contextual-typing-gate.core.types.ts`, and this is the
    // refusal that pin points at. A misspelled verb is silently-dropped
    // memberships reported as success if the bag ever stops being strict.
    //
    // Beside a REAL verb in both cases: a lone unknown key would be refused by
    // any object schema, which is not the property under test.
    const misspelledUpdate = {
      connect: [{ type: "photo", where: { id: "p" } }],
      connct: [{ type: "photo", where: { id: "q" } }],
    };
    expect(accepts("update", misspelledUpdate)).toBe(false);
    expect(
      parse(core().update, { items: misspelledUpdate }).issues?.[0]?.message
    ).toBe("Unknown key: connct");

    const misspelledCreate = {
      connect: [{ type: "photo", where: { id: "p" } }],
      creat: [{ type: "photo", data: { id: "q", caption: "c" } }],
    };
    expect(accepts("create", misspelledCreate)).toBe(false);
    expect(
      parse(core().create, { id: "o1", title: "t", items: misspelledCreate })
        .issues?.[0]?.message
    ).toBe("Unknown key: creat");
  });
});

/**
 * THE INVERSE-COLLECTION WRITE LATTICE — BOTH ARITIES, both ordinary, which is
 * where plan §9.4 and §9.5 put them.
 *
 * `getRelationSchemas` used to substitute a refusal into the two write families
 * of a fields-less `manyToOne`/`manyToMany` bound to a collection group. Neither
 * substitution is left:
 *
 *   - the PLURAL inverse (§9.5) is a fixed-variant ordinary junction VIEW. The
 *     binder supplies the same topology in reverse orientation and
 *     `RelationJunctionPart` owns every verb unchanged;
 *   - the SINGULAR inverse (§9.4) is a to-one SLOT — one member-junction row
 *     under a UNIQUE over the complete variant side — and takes the ordinary
 *     to-one families. What is not ordinary is the LOWERING, and that is
 *     `RelationJunctionToOnePart`'s: `disconnect: true` deletes THE junction row
 *     (a singular slot needs no selector), `delete: true` deletes the single
 *     connected OWNER row rather than sweeping a connected set, and
 *     `update`/`upsert` correlate through the membership.
 *
 * Neither spelling carries a `type` discriminator: the variant is fixed by which
 * model declares the inverse.
 */
const inverseSchema = (() => {
  const book = s.model({
    id: s.string().id(),
    title: s.string(),
    // SINGULAR inverse of a collection group.
    shelf: s.manyToOne(() => shelf).optional(),
  });
  const clip = s.model({
    id: s.string().id(),
    // PLURAL inverse of the same group.
    shelves: s.manyToMany(() => shelf),
  });
  const shelf = s.model({
    id: s.string().id(),
    label: s.string(),
    items: s.polymorphicToMany(
      { book: () => book, clip: () => clip },
      { values: { book: "inv.book.v1", clip: "inv.clip.v1" } }
    ),
  });
  return { book, clip, shelf };
})();

hydrateSchemaNames(inverseSchema);
const inverseRegistry = createSchemaRegistry(inverseSchema);

describe("both inverse collection arities take the ordinary write families", () => {
  test("the SINGULAR inverse takes the ORDINARY to-one families, whole", () => {
    // §9.4 — the create-root triple, the update lattice's two correlated
    // modifies, and BOTH removal verbs (which hang on `slotMayBeEmpty` alone,
    // and `P021` forces `.optional()` on exactly this shape).
    expect(
      parse(inverseRegistry.proxy.book.core.update, {
        shelf: { connect: { id: "s1" } },
      }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.book.core.update, {
        shelf: { disconnect: true },
      }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.book.core.update, { shelf: { delete: true } })
        .issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.book.core.update, {
        shelf: { update: { label: "renamed" } },
      }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.book.core.update, {
        shelf: {
          upsert: {
            create: { id: "s2", label: "made" },
            update: { label: "kept" },
          },
        },
      }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.book.core.create, {
        id: "b1",
        title: "t",
        shelf: { connect: { id: "s1" } },
      }).issues
    ).toBeUndefined();
    // …and the composition lattice comes with them: a vacate, a supplier and a
    // modify of the SUPPLIED owner is one accepted payload.
    expect(
      parse(inverseRegistry.proxy.book.core.update, {
        shelf: {
          disconnect: true,
          connect: { id: "s1" },
          update: { label: "renamed" },
        },
      }).issues
    ).toBeUndefined();
  });

  test("the SINGULAR inverse is a TO-ONE family, not a to-many one", () => {
    // The slot holds at most one membership, so no plural verb and no array
    // spelling reaches it — the arity half of the dispatch, still doing work.
    expect(
      parse(inverseRegistry.proxy.book.core.update, {
        shelf: { set: [{ id: "s1" }] },
      }).issues
    ).toBeDefined();
    expect(
      parse(inverseRegistry.proxy.book.core.update, {
        shelf: { connect: [{ id: "s1" }] },
      }).issues
    ).toBeDefined();
  });

  test("the PLURAL inverse takes the ORDINARY to-many families, whole", () => {
    // §9.5 — a polymorphic-bound `manyToMany` is a fixed-variant junction view,
    // so every ordinary junction verb parses, in the ordinary (untagged)
    // spelling: the variant is fixed by the declaration, so there is no `type`.
    expect(
      parse(inverseRegistry.proxy.clip.core.update, { shelves: { set: [] } })
        .issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.clip.core.update, {
        shelves: {
          connect: [{ id: "s1" }],
          disconnect: [{ id: "s2" }],
          create: [{ id: "s3", label: "L" }],
          deleteMany: [{ id: { equals: "s4" } }],
        },
      }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.clip.core.create, {
        id: "c1",
        shelves: { connect: [{ id: "s1" }] },
      }).issues
    ).toBeUndefined();
    // …and the TAGGED spelling is not this grammar: the discriminator belongs to
    // the OWNER's collection family, where the variant is still open.
    expect(
      parse(inverseRegistry.proxy.clip.core.update, {
        shelves: { connect: [{ type: "clip", where: { id: "s1" } }] },
      }).issues
    ).toBeDefined();
  });

  test("inverse READS are untouched — Package C landed them", () => {
    // The control that outlived the substitution: reads never depended on it,
    // and they still answer the same for both arities.
    expect(
      parse(inverseRegistry.proxy.book.core.where, {
        shelf: { is: { id: { equals: "s1" } } },
      }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.book.core.select, { shelf: true }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.clip.core.select, { shelves: true }).issues
    ).toBeUndefined();
    expect(
      parse(inverseRegistry.proxy.clip.core.orderBy, {
        shelves: { _count: "desc" },
      }).issues
    ).toBeUndefined();
  });

  test("an ORDINARY relation on the same model keeps its whole write family", () => {
    // Nothing about a polymorphic neighbour narrows an ordinary relation, and
    // nothing ever did.
    expect(
      parse(inverseRegistry.proxy.shelf.core.update, { label: "renamed" })
        .issues
    ).toBeUndefined();
  });
});
