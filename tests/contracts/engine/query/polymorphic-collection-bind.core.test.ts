import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  bindRelation,
  classifyRelation,
} from "@query-engine/builders/relation-data-builder";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { validateSchema } from "@schema/validation";
import { describe, expect, test } from "vitest";

/**
 * B2's engine containment narrow (`relation-data-builder.ts`,
 * `bindResolvedPolymorphicInverse`): a resolved polymorphic binding whose
 * stored descriptor is the `kind: "toMany"` arm is refused exactly like
 * missing storage — the member-table view binds only in Package C.
 *
 * Reached WITHOUT a client, because the schema below is R003-invalid by design:
 * its `oneToMany` back-reference is a row-held shape, which no longer binds a
 * collection group, and no ordinary inverse carries the edge. So this drives a
 * directly-built scope over a `validateSchema`'d schema — validation is still
 * what MATERIALIZES the stored collection descriptor the narrow must refuse.
 */
describe("collection descriptor at the engine bind boundary", () => {
  test("a resolved binding onto toMany storage is refused as unbound", () => {
    const owner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { catalog: () => catalog },
        { values: { catalog: "bind.catalog.v1" } }
      ),
    });
    const catalog = s.model({
      id: s.string().id(),
      owners: s.oneToMany(() => owner),
    });
    const schema = { owner, catalog };
    hydrateSchemaNames(schema);
    // R003 is the schema's own verdict since B3's retained-shape tightening:
    // `owners` is a row-held `oneToMany`, which binds only toOne groups now, so
    // it has no inverse of any kind. That is a fact about the SCHEMA, not about
    // this narrow — the bind below still reaches the collection descriptor,
    // because `bindRowHeldRelation` asks the RAW `resolveInverseRelation`
    // (untightened by design) rather than the compatible-binding projection.
    // The call is kept because it MATERIALIZES the descriptor the narrow refuses.
    expect(validateSchema(schema).errors.map((entry) => entry.code)).toEqual([
      "R003",
    ]);
    expect(owner["~"].getPolymorphicStorage("items")?.kind).toBe("toMany");

    const scope = createQueryScope(new PostgresAdapter(), catalog);
    const relationInfo = getRelationInfo(scope, "owners");
    expect(relationInfo).toBeDefined();
    if (!relationInfo) return;

    expect(() => bindRelation(scope, relationInfo)).toThrowError(
      "Polymorphic inverse 'owners' has no resolved storage binding."
    );
  });
});

/**
 * The two inverse shapes of a VALID collection schema — the §2.2 topology cells
 * Package C binds as the MEMBER-TABLE VIEW. Validation ACCEPTS both spellings
 * (the positive twin in
 * `tests/unit/schema-validation/polymorphic-rules.core.test.ts` pins that), so
 * no schema rule can own these; the engine answers for both itself.
 *
 * B3 left them as two refusals — a typed one in the manyToMany bind thunk and
 * the generic FK message for the fields-less manyToOne — and recorded that C
 * would amend them consciously. This is that amendment: both now bind, and what
 * is measured is the BOUND VIEW rather than an error string.
 *
 * Driven through a directly-built scope, which is the narrowest way to reach
 * the seam.
 */
describe("collection inverses at the engine bind boundary", () => {
  /** The two-C-shape schema: singular manyToOne inverse, plural manyToMany inverse. */
  function buildCollectionSchema() {
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
      items: s.polymorphicToMany(
        { article: () => article, photo: () => photo },
        { values: { article: "cell.article.v1", photo: "cell.photo.v1" } }
      ),
    });
    const schema = { article, photo, owner };
    hydrateSchemaNames(schema);
    return { ...schema, errors: validateSchema(schema).errors };
  }

  // The PREMISE of both tests below, measured once and owned here: the schema
  // they drive is fully legal — a §2.2 topology cell. That is exactly why the
  // engine must answer for these two edges itself: no validation rule will. If
  // this ever reddens, the two refusals below stop being engine residuals and
  // become validation's business instead.
  test("the two-C-shape collection schema is fully legal", () => {
    expect(buildCollectionSchema().errors).toEqual([]);
  });

  test("a bound manyToMany binds the PLURAL member-table view", () => {
    const { photo, owner } = buildCollectionSchema();
    const scope = createQueryScope(new PostgresAdapter(), photo);
    const relationInfo = getRelationInfo(scope, "galleries");
    expect(relationInfo).toBeDefined();
    if (!relationInfo) return;

    // CLASSIFICATION itself stays refusal-free — that is the documented
    // contract of `ClassifiedRelation`, and callers classify before they know
    // whether they will bind.
    const classified = classifyRelation(scope, relationInfo);
    expect(classified.kind).toBe("junction");
    if (classified.kind !== "junction") return;

    const bound = classified.bind();
    // The MEMBER table, never an ordinary `owner_photo` pair table: the
    // serializer emits only the member junctions, so a pair-table binding would
    // compile SQL that fails at the database with a missing table.
    expect(bound.membership.table).toBe("owner_items_photo");
    expect(bound.membership.polymorphicMember).toBe(true);
    // SIDES SWAPPED for a traversal that starts at the variant: `source` is the
    // asking model's end, `target` is the collection owner's.
    expect(bound.membership.source.model).toBe(photo);
    expect(bound.membership.target.model).toBe(owner);
    expect(bound.membership.source.members).toEqual([
      { junctionField: "photoId", referencedField: "id" },
    ]);
    expect(bound.membership.target.members).toEqual([
      { junctionField: "ownerId", referencedField: "id" },
    ]);
    // A fields-less manyToMany asker binds the PLURAL member view.
    expect(bound.cardinality).toBe("many");
  });

  test("a bound fields-less manyToOne binds the SINGULAR member-table view", () => {
    const { article, owner } = buildCollectionSchema();
    const scope = createQueryScope(new PostgresAdapter(), article);
    const relationInfo = getRelationInfo(scope, "gallery");
    expect(relationInfo).toBeDefined();
    if (!relationInfo) return;

    // B3 sent this shape through `bindRowHeldRelation`, where the ORDINARY-ONLY
    // resolution answered `missing` and produced the generic FK message. C
    // intercepts it at the classify seam instead: its membership lives in the
    // member junction, so it is a JUNCTION however its declared `type` reads.
    const classified = classifyRelation(scope, relationInfo);
    expect(classified.kind).toBe("junction");

    const bound = bindRelation(scope, relationInfo);
    expect(bound.position).toBe("junction");
    if (bound.position !== "junction") return;
    expect(bound.membership.table).toBe("owner_items_article");
    expect(bound.membership.source.model).toBe(article);
    expect(bound.membership.target.model).toBe(owner);
    // THE FIRST `"one"` JUNCTION IN THE ESTATE. `bindJunctionRelation` writes
    // `"many"` unconditionally for ordinary pairs; a member whose inverse is
    // singular is physically backed by the UNIQUE over the complete target
    // side, and the read leaf owes it one row or null.
    expect(bound.cardinality).toBe("one");
  });
});
