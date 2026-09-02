import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator, validateSchema } from "@src/schema/validation";
import type {
  ResolvedRelationEdge,
  ResolvedSlot,
} from "@src/schema/validation/relation-resolution";
import { describe, expect, it } from "vitest";

/**
 * THE VARIANT TOPOLOGY MATRIX (plan §6.5; falsifiers §11.3.1-8, 12).
 *
 * The CARRIER's cardinality selects the storage family; a BOUND inverse's
 * cardinality selects target-side uniqueness. All four cells are valid, and the
 * two families differ in exactly one way: a row-held carrier has ONE portable
 * `(type, id)` index for the whole group, so its bound inverses must agree,
 * while each member junction is its own table and derives uniqueness alone.
 */

function resolve(schema: Record<string, AnyModel>) {
  hydrateSchemaNames(schema);
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  if (!resolution.ok) {
    throw new Error(
      `fixture did not resolve: ${resolution.issues.map((i) => i.code).join(", ")}`
    );
  }
  return resolution.index;
}

function codes(schema: Record<string, AnyModel>): string[] {
  hydrateSchemaNames(schema);
  return validateSchema(schema).errors.map((issue) => issue.code);
}

function carrierEdge(slot: ResolvedSlot | undefined): ResolvedRelationEdge {
  if (!slot) throw new Error("no resolved carrier slot");
  return slot.edge;
}

/** The resolved edge behind `schema[modelKey].field`. */
function edgeAt(
  schema: Record<string, AnyModel>,
  modelKey: string,
  field: string
): ResolvedRelationEdge {
  const model = schema[modelKey];
  if (!model) throw new Error(`no model '${modelKey}' in fixture`);
  return carrierEdge(resolve(schema).get(model)?.get(field));
}

/** carrier cardinality × inverse cardinality, one variant, one target. */
function cell(
  carrier: "one" | "many",
  inverse: "one" | "many" | "none"
): Record<string, AnyModel> {
  const post = s.model({
    id: s.string().id(),
    ...(inverse === "none"
      ? {}
      : {
          back:
            inverse === "one"
              ? s.toOne(() => comment).name("subject")
              : s.toMany(() => comment).name("subject"),
        }),
  });
  const map = { post: () => post };
  const comment = s.model({
    id: s.string().id(),
    subject:
      carrier === "one"
        ? s.toOne(map).name("subject")
        : s.toMany(map).name("subject"),
  });
  return { post, comment };
}

describe("the four carrier/inverse cells (§11.3.1)", () => {
  it.each([
    ["one", "one", true],
    ["one", "many", false],
  ] as const)("toOne(map) with a to-%s inverse is row-held storage, unique=%s", (_carrier, inverse, unique) => {
    const schema = cell("one", inverse);
    const edge = edgeAt(schema, "comment", "subject");

    expect(edge.kind).toBe("variantRowCarrier");
    if (edge.kind !== "variantRowCarrier") return;
    expect(edge.uniqueTarget).toBe(unique);
    expect(edge.storage.typeColumn.name).toBe("subject_type");
    expect(edge.storage.idColumn.name).toBe("subject_id");
    expect(edge.storage.indexName).toBe("comment_subject_poly_idx");
  });

  it.each([
    ["one", true],
    ["many", false],
  ] as const)("toMany(map) with a to-%s inverse is a member junction, uniqueTarget=%s", (inverse, unique) => {
    const schema = cell("many", inverse);
    const edge = edgeAt(schema, "comment", "subject");

    expect(edge.kind).toBe("variantJunctionCarrier");
    if (edge.kind !== "variantJunctionCarrier") return;
    expect(edge.members[0].uniqueTarget).toBe(unique);
    expect(edge.members[0].topology.table).toBe("comment_subject_post");
  });
});

describe("direct-only members (§11.3.2)", () => {
  it("resolve, with non-unique membership, in both storage families", () => {
    for (const carrier of ["one", "many"] as const) {
      const schema = cell(carrier, "none");
      const edge = edgeAt(schema, "comment", "subject");

      if (edge.kind === "variantRowCarrier") {
        expect(edge.uniqueTarget).toBe(false);
        expect(edge.members[0].inverse).toBeUndefined();
        continue;
      }
      if (edge.kind !== "variantJunctionCarrier") throw new Error("wrong kind");
      expect(edge.members[0].uniqueTarget).toBe(false);
      expect(edge.members[0].inverse).toBeUndefined();
    }
  });
});

describe("row-held group uniformity (§11.3.3)", () => {
  function rowGroup(
    postInverse: "one" | "many",
    videoInverse: "one" | "many" | "none"
  ): Record<string, AnyModel> {
    const post = s.model({
      id: s.string().id(),
      back:
        postInverse === "one"
          ? s.toOne(() => comment).name("subject")
          : s.toMany(() => comment).name("subject"),
    });
    const video = s.model({
      id: s.string().id(),
      ...(videoInverse === "none"
        ? {}
        : {
            back:
              videoInverse === "one"
                ? s.toOne(() => comment).name("subject")
                : s.toMany(() => comment).name("subject"),
          }),
    });
    const comment = s.model({
      id: s.string().id(),
      subject: s
        .toOne({ post: () => post, video: () => video })
        .name("subject"),
    });
    return { post, video, comment };
  }

  it("accepts an all-one group and an all-many group", () => {
    for (const [a, b, unique] of [
      ["one", "one", true],
      ["many", "many", false],
    ] as const) {
      const schema = rowGroup(a, b);
      const edge = edgeAt(schema, "comment", "subject");
      if (edge.kind !== "variantRowCarrier") throw new Error("wrong kind");
      expect(edge.uniqueTarget).toBe(unique);
    }
  });

  it("refuses a MIXED group — one index cannot be both", () => {
    expect(codes(rowGroup("one", "many"))).toEqual(["P012"]);
  });

  it("makes an unbound member inherit the carrier-wide answer", () => {
    // `video` binds nothing, so its uniqueness is not computed member-locally:
    // it is the one carrier answer, which `post`'s to-one inverse decided.
    const schema = rowGroup("one", "none");
    const edge = edgeAt(schema, "comment", "subject");

    if (edge.kind !== "variantRowCarrier") throw new Error("wrong kind");
    expect(edge.uniqueTarget).toBe(true);
    expect(edge.members.map((member) => member.variant)).toEqual([
      "post",
      "video",
    ]);
    expect(edge.members.at(1)?.inverse).toBeUndefined();
  });
});

describe("member-junction independence (§11.3.4)", () => {
  it("lets each variant derive its own target-side uniqueness", () => {
    const post = s.model({
      id: s.string().id(),
      back: s.toOne(() => shelf).name("items"),
    });
    const video = s.model({
      id: s.string().id(),
      back: s.toMany(() => shelf).name("items"),
    });
    const shelf = s.model({
      id: s.string().id(),
      items: s.toMany({ post: () => post, video: () => video }).name("items"),
    });
    const schema = { post, video, shelf };
    const edge = edgeAt(schema, "shelf", "items");

    if (edge.kind !== "variantJunctionCarrier") throw new Error("wrong kind");
    expect(
      edge.members.map((member) => [member.variant, member.uniqueTarget])
    ).toEqual([
      ["post", true],
      ["video", false],
    ]);
  });
});

describe("refused variant shapes", () => {
  it("refuses two inverses competing for one member (§11.3.5)", () => {
    const book = s.model({
      id: s.string().id(),
      shelf: s.toOne(() => shelf),
      shelves: s.toMany(() => shelf),
    });
    const shelf = s.model({
      id: s.string().id(),
      items: s.toMany({ book: () => book }),
    });

    expect(codes({ book, shelf })).toEqual(["R009"]);
  });

  it("accepts a repeated target model for direct reads (§11.3.6)", () => {
    const doc = s.model({ id: s.string().id() });
    const audit = s.model({
      id: s.string().id(),
      subject: s.toOne(
        { draft: () => doc, published: () => doc },
        { values: { draft: "doc.draft.v1", published: "doc.published.v1" } }
      ),
    });

    expect(codes({ doc, audit })).toEqual([]);
  });

  it("refuses a repeated target whose inverse cannot choose (§11.3.6)", () => {
    const doc = s.model({
      id: s.string().id(),
      audits: s.toMany(() => audit).name("subject"),
    });
    const audit = s.model({
      id: s.string().id(),
      subject: s
        .toOne(
          { draft: () => doc, published: () => doc },
          { values: { draft: "doc.draft.v1", published: "doc.published.v1" } }
        )
        .name("subject"),
    });

    expect(codes({ doc, audit })).toEqual(["R009"]);
  });

  it("resolves the repair: separate carrier fields with matching names", () => {
    const doc = s.model({
      id: s.string().id(),
      drafts: s.toMany(() => audit).name("draftSubject"),
      published: s.toMany(() => audit).name("publishedSubject"),
    });
    const audit = s.model({
      id: s.string().id(),
      draftSubject: s
        .toOne({ draft: () => doc }, { values: { draft: "doc.draft.v1" } })
        .name("draftSubject"),
      publishedSubject: s
        .toOne(
          { published: () => doc },
          { values: { published: "doc.published.v1" } }
        )
        .name("publishedSubject"),
    });

    expect(codes({ doc, audit })).toEqual([]);
  });

  it("binds ONE of two carriers over the same target and leaves the other direct-only (D26)", () => {
    // The repair above binds BOTH carriers because it wants both inverses. Only
    // the bound one has to be named: §6.2 rule 4 reads the candidate count AFTER
    // the label partition, so `quoted`'s member — which claims no name — has
    // ZERO candidates, not a mismatch with `post.comments`, and a variant member
    // with zero candidates is a valid direct-only member.
    const post = s.model({
      id: s.string().id(),
      comments: s.toMany(() => comment).name("subject"),
    });
    const comment = s.model({
      id: s.string().id(),
      subject: s.toOne({ post: () => post }).name("subject"),
      quoted: s.toOne({ post: () => post }),
    });
    const schema = { post, comment };

    expect(codes(schema)).toEqual([]);
    const bound = edgeAt(schema, "comment", "subject");
    const direct = edgeAt(schema, "comment", "quoted");
    if (bound.kind !== "variantRowCarrier") throw new Error("wrong kind");
    if (direct.kind !== "variantRowCarrier") throw new Error("wrong kind");
    expect(bound.members[0]?.inverse?.field).toBe("comments");
    expect(direct.members[0]?.inverse).toBeUndefined();
  });

  it("refuses an inverse that owns a foreign key or a junction (§11.3.7)", () => {
    const withFk = () => {
      const book = s.model({
        id: s.string().id(),
        shelfId: s.string(),
        shelf: s
          .toOne(() => shelf)
          .fields("shelfId")
          .references("id"),
      });
      const shelf = s.model({
        id: s.string().id(),
        items: s.toMany({ book: () => book }),
      });
      return { book, shelf };
    };
    const withJunction = () => {
      const book = s.model({
        id: s.string().id(),
        shelves: s.toMany(() => shelf).through("book_shelf_links"),
      });
      const shelf = s.model({
        id: s.string().id(),
        items: s.toMany({ book: () => book }),
      });
      return { book, shelf };
    };

    expect(codes(withFk())).toEqual(["R012"]);
    expect(codes(withJunction())).toEqual(["R012"]);
  });

  it("keeps the portable single-scalar identity restriction (§11.3.8)", () => {
    const post = s.model({ id: s.string().id() });
    const clip = s.model({ id: s.int().id() });
    const comment = s.model({
      id: s.string().id(),
      subject: s.toOne({ post: () => post, clip: () => clip }),
    });

    expect(codes({ post, clip, comment })).toEqual(["P002"]);
  });

  it("supports a compound target row key through a member junction (§11.3.8)", () => {
    const chapter = s
      .model({ bookId: s.string(), index: s.string() })
      .id(["bookId", "index"]);
    const shelf = s.model({
      id: s.string().id(),
      items: s.toMany({ chapter: () => chapter }),
    });
    const edge = edgeAt({ chapter, shelf }, "shelf", "items");

    if (edge.kind !== "variantJunctionCarrier") throw new Error("wrong kind");
    expect(edge.members[0].topology.target.members).toEqual([
      { junctionField: "chapter_1", referencedField: "bookId" },
      { junctionField: "chapter_2", referencedField: "index" },
    ]);
  });
});

describe("the stored discriminator (§11.3.12)", () => {
  it("survives a public key rename because the member holds the entry", () => {
    const doc = s.model({ id: s.string().id() });
    const before = s.model({
      id: s.string().id(),
      subject: s.toOne({ old: () => doc }, { values: { old: "doc.v1" } }),
    });
    const after = s.model({
      id: s.string().id(),
      subject: s.toOne(
        { renamed: () => doc },
        { values: { renamed: "doc.v1" } }
      ),
    });
    const read = (owner: AnyModel, key: string) => {
      const edge = edgeAt({ doc, [key]: owner }, key, "subject");
      if (edge.kind !== "variantRowCarrier") throw new Error("wrong kind");
      return edge.members[0];
    };

    const renamed = read(after, "after");
    expect(read(before, "before").entry.storedValue).toBe("doc.v1");
    // The public key changed; the stored discriminator did not, and neither
    // family guessed a rename from the key.
    expect(renamed.entry.storedValue).toBe("doc.v1");
    expect(renamed.variant).toBe("renamed");
  });
});
