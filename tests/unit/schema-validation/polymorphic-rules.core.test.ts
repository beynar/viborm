import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { PG, s } from "@src/schema";
import type { AnyModel } from "@src/schema/model";
import { validateSchema } from "@src/schema/validation";
import { SchemaValidationError } from "@src/schema/validation/error";
import type { ResolvedRelationEdge } from "@src/schema/validation/relation-resolution";
import {
  resolveSchemaOrThrow,
  validateSchemaOrThrow,
} from "@src/schema/validation/validator";
import { describe, expect, it } from "vitest";

class DefinitionDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();

  constructor() {
    super("postgresql", "polymorphic-definition");
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // The definition driver owns no provider resource.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

function codes(result: ReturnType<typeof validateSchema>): string[] {
  return result.errors.map((entry) => entry.code);
}

function warnings(result: ReturnType<typeof validateSchema>): string[] {
  return result.warnings.map((entry) => entry.code);
}

/**
 * The RESOLVED carrier edge for one slot — the topology's only owner.
 *
 * A schema that does not resolve publishes NO topology at all, which is why the
 * refusal cases below read `undefined` here: there is no per-model descriptor
 * map left in which a refused carrier could leave a half-built entry.
 */
function carrierEdge(
  schema: Record<string, AnyModel>,
  model: AnyModel,
  field: string
): ResolvedRelationEdge | undefined {
  try {
    return resolveSchemaOrThrow(schema).get(model)?.get(field)?.edge;
  } catch {
    return undefined;
  }
}

/** Narrow a carrier edge to the row-held arm these pins assert against. */
function rowCarrier(
  schema: Record<string, AnyModel>,
  model: AnyModel,
  field: string
) {
  const edge = carrierEdge(schema, model, field);
  return edge?.kind === "variantRowCarrier" ? edge : undefined;
}

describe("polymorphic definition rules", () => {
  it("builds one trusted private storage descriptor", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const commentable = s.toOne({
      post: () => post,
      video: () => video,
    });
    const comment = s.model({ id: s.string().id(), commentable });

    const result = validateSchema({ post, video, comment });

    expect(result.errors).toEqual([]);
    const edge = rowCarrier({ post, video, comment }, comment, "commentable");
    expect(edge).toMatchObject({
      carrier: { source: comment, field: "commentable" },
      uniqueTarget: false,
      storage: {
        indexName: "comment_commentable_poly_idx",
        typeColumn: { name: "commentable_type", nullable: false },
        idColumn: { name: "commentable_id", nullable: false },
      },
    });
    expect(
      edge?.members.map((member) => [
        member.variant,
        {
          storedValue: member.entry.storedValue,
          targetModel: member.targetModel,
          referencedField: member.referencedField,
        },
      ])
    ).toEqual([
      [
        "post",
        { storedValue: "post", targetModel: post, referencedField: "id" },
      ],
      [
        "video",
        { storedValue: "video", targetModel: video, referencedField: "id" },
      ],
    ]);
  });

  // §2.2 TOPOLOGY CELL 1 — the plainest collection a user can spell.
  //
  // This assertion was `["P014"]` until Package B3. P014 was the blanket
  // "collection serialization is not implemented yet" refusal, and deleting it
  // is what makes a collection schema DECLARABLE AND MIGRATABLE: the member
  // junction tables now exist in the DDL. Reading and writing the slot through
  // the client is still refused, but by the operation-schema omission, not
  // here — a change of owner, not a relaxation.
  //
  // It says nothing about `optional`, which is unspellable on a collection
  // state and is pinned at the type level in
  // `tests/types/relations/polymorphic-carrier.core.types.ts`.
  it("accepts a declared collection carrier", () => {
    const post = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      attachments: s.toMany(
        { post: () => post },
        { values: { post: "attachment.post.v1" } }
      ),
    });

    const result = validateSchema({ post, owner });

    expect(codes(result)).toEqual([]);
  });

  // Two readers reach a cardinality-less carrier BEFORE the per-relation loop
  // that ejects it on P013, and both walk every carrier the target holds through
  // `relation["~"].targetEntries()` unguarded. The FIRST to trip — measured, by
  // deleting the carrier's closure and reading the stack — is the schema rule
  // `relationHasInverse`, via `hasInverse` → `getPolymorphicInverseBinding` →
  // `resolveInverseRelation` → `selectPolymorphicInverse` →
  // `getPolymorphicInverseCandidates` (`inverse.ts`); it fails with
  // `[S001] … targetEntries is not a function`. (`collectInverseCandidates` is
  // the ORDINARY scan and never touches the closure.) `validateInverseBindings`
  // (`rules/polymorphic.ts`) reaches the same closure independently. So that
  // closure is what keeps a hostile schema producing one owned issue instead of
  // a TypeError, and it is load-bearing on two independent paths.
  // The "one owned issue" ejection contract belongs to P013 ALONE: a carrier
  // refused for its MISSING cardinality must not also be diagnosed for its
  // content — remove the P013 `continue` in `validatePolymorphicRelations` and
  // the first assertion gains a second code.
  //
  // A COLLECTION carrier's contract is the opposite, and always was: its
  // content pipeline runs in full. Until B3 a blanket P014 was then appended
  // last, so a hostile collection carrier came back diagnosed AND refused; with
  // P014 gone the diagnosis stands alone, which is the point — the content
  // rules are the only judges of a collection schema now. Both carriers below
  // carry content P003 refuses (an empty values map beside a non-empty target
  // map), so the pair still measures the ejection asymmetry.
  // The snapshot is a DATA snapshot: every own property of `targets` and
  // `values` is read exactly once, at construction. A live accessor answering
  // validation with one value and storage with another is the dodge this pins —
  // before the data snapshot, this getter passed validation on its second read
  // while the storage descriptor kept the hostile first read.
  it("stores reused declarations per owner and field", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const target = s.toOne(
      { post: () => post, video: () => video },
      { values: { post: "post.v1", video: "video.v1" } }
    );
    const first = s.model({ id: s.string().id(), target });
    const second = s.model({ id: s.string().id(), subject: target });

    expect(validateSchema({ post, video, first }).errors).toEqual([]);
    expect(validateSchema({ post, video, second }).errors).toEqual([]);

    // ONE terminal, TWO contextual slots: each schema resolves its own carrier,
    // and the physical names follow the SLOT, never the shared declaration.
    expect(
      rowCarrier({ post, video, first }, first, "target")?.storage.indexName
    ).toBe("first_target_poly_idx");
    expect(
      rowCarrier({ post, video, second }, second, "subject")?.storage.indexName
    ).toBe("second_subject_poly_idx");
  });

  it("rejects unregistered targets and missing primary keys", () => {
    const unregistered = s.model({ id: s.string().id() });
    const noPrimaryKey = s.model({ id: s.string() });
    const owner = s.model({
      id: s.string().id(),
      target: s.toOne(
        {
          absent: () => unregistered,
          noKey: () => noPrimaryKey,
        },
        {
          values: { absent: "absent.v1", noKey: "no-key.v1" },
        }
      ),
    });

    const result = validateSchema({ owner, noPrimaryKey });

    expect(codes(result)).toContain("P001");
    expect(codes(result)).toContain("P009");
  });

  it("attributes a thrown variant getter to that variant and carries its cause", () => {
    // The once-cell settles the throw; the resolver names WHICH variant threw
    // and hands the settled Error on as the refusal's cause, so a broken import
    // is diagnosable without re-invoking the getter.
    const post = s.model({ id: s.string().id() });
    const failure = new Error("target module missing");
    const owner = s.model({
      id: s.string().id(),
      subject: s.toOne({
        post: () => post,
        video: () => {
          throw failure;
        },
      }),
    });

    const result = validateSchema({ post, owner });
    expect(codes(result)).toEqual(["P001"]);
    expect(result.errors[0]?.message).toBe(
      "Target getter for variant 'video' of 'owner.subject' threw: target module missing"
    );

    let thrown: unknown;
    try {
      resolveSchemaOrThrow({ post, owner });
    } catch (error) {
      thrown = error;
    }
    // A refusal with no settled Error behind it carries no cause at all; this
    // one does, so the boundary error chains to what the getter actually threw.
    expect(
      thrown instanceof SchemaValidationError &&
        thrown.originalCause !== undefined
    ).toBe(true);
  });

  it("rejects incompatible and array primary-key storage", () => {
    const stringTarget = s.model({ id: s.string().id() });
    const intTarget = s.model({ id: s.int().id() });
    const arrayTarget = s.model({ id: s.string().array().id() });
    const owner = s.model({
      id: s.string().id(),
      mixed: s.toOne(
        { string: () => stringTarget, int: () => intTarget },
        { values: { string: "string.v1", int: "int.v1" } }
      ),
      array: s.toOne(
        { string: () => stringTarget, array: () => arrayTarget },
        { values: { string: "string.v1", array: "array.v1" } }
      ),
    });

    const result = validateSchema({
      stringTarget,
      intTarget,
      arrayTarget,
      owner,
    });

    expect(codes(result).filter((code) => code === "P002")).toHaveLength(2);
  });

  it("lets an ordinary inverse bind one polymorphic member", () => {
    const post = s.model({
      id: s.string().id(),
      comments: s.toMany(() => comment).name("commentableTarget"),
    });
    const video = s.model({ id: s.string().id() });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .toOne(
          { post: () => post, video: () => video },
          { values: { post: "post.v1", video: "video.v1" } }
        )
        .name("commentableTarget"),
    });

    expect(codes(validateSchema({ post, video, comment }))).not.toContain(
      "R003"
    );
  });

  it("stores one relation-wide cardinality for fields-less one-to-one inverses", () => {
    const post = s.model({
      id: s.string().id(),
      featuredComment: s.toOne(() => comment).name("commentable"),
    });
    const video = s.model({
      id: s.string().id(),
      featuredComment: s.toOne(() => comment).name("commentable"),
    });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .toOne({ post: () => post, video: () => video })
        .name("commentable"),
    });

    const result = validateSchema({ post, video, comment });

    expect(result.errors).toEqual([]);
    expect(
      rowCarrier({ post, video, comment }, comment, "commentable")?.uniqueTarget
    ).toBe(true);
  });

  it("rejects mixed inverse cardinalities for one polymorphic storage", () => {
    const post = s.model({
      id: s.string().id(),
      comments: s.toMany(() => comment).name("commentable"),
    });
    const video = s.model({
      id: s.string().id(),
      featuredComment: s.toOne(() => comment).name("commentable"),
    });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .toOne({ post: () => post, video: () => video })
        .name("commentable"),
    });

    const result = validateSchema({ post, video, comment });

    expect(codes(result)).toContain("P012");
    expect(
      carrierEdge({ post, video, comment }, comment, "commentable")
    ).toBeUndefined();
  });

  it("applies a resolved singular cardinality to variants without inverses", () => {
    const post = s.model({
      id: s.string().id(),
      featuredComment: s.toOne(() => comment).name("commentable"),
    });
    const video = s.model({ id: s.string().id() });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .toOne({ post: () => post, video: () => video })
        .name("commentable"),
    });

    const result = validateSchema({ post, video, comment });

    expect(result.errors).toEqual([]);
    expect(
      rowCarrier({ post, video, comment }, comment, "commentable")?.uniqueTarget
    ).toBe(true);
  });

  it("keeps an ordinary inverse when unnamed polymorphic alternatives coexist", () => {
    const source = s.model({
      id: s.string().id(),
      children: s.toMany(() => child),
    });
    const other = s.model({ id: s.string().id() });
    const child = s.model({
      id: s.string().id(),
      sourceId: s.string(),
      source: s
        .toOne(() => source)
        .fields("sourceId")
        .references("id"),
      first: s.toOne(
        { source: () => source, other: () => other },
        { values: { source: "first.source.v1", other: "first.other.v1" } }
      ),
      second: s.toOne(
        { source: () => source, other: () => other },
        { values: { source: "second.source.v1", other: "second.other.v1" } }
      ),
    });

    expect(codes(validateSchema({ source, other, child }))).not.toContain(
      "P005"
    );
  });

  it("resolves each target getter once across inverse and storage validation", () => {
    let sourceReads = 0;
    let videoReads = 0;
    const source = s.model({
      id: s.string().id(),
      targets: s.toMany(() => target),
    });
    const video = s.model({ id: s.string().id() });
    const target = s.model({
      id: s.string().id(),
      subject: s.toOne(
        {
          source: () => {
            sourceReads += 1;
            return source;
          },
          video: () => {
            videoReads += 1;
            return video;
          },
        },
        { values: { source: "source.v1", video: "video.v1" } }
      ),
    });

    expect(validateSchema({ source, video, target }).errors).toEqual([]);
    expect(sourceReads).toBe(1);
    expect(videoReads).toBe(1);
  });

  it("ignores a decorative name mismatch when only one relation can bind", () => {
    const source = s.model({
      id: s.string().id(),
      targets: s.toMany(() => target).name("ordinaryName"),
    });
    const target = s.model({
      id: s.string().id(),
      source: s
        .toOne({ source: () => source }, { values: { source: "source.v1" } })
        .name("decorativeName"),
    });

    const result = validateSchema({ source, target });

    expect(codes(result)).not.toContain("P004");
    expect(codes(result)).not.toContain("P005");
    expect(codes(result)).not.toContain("P010");
    expect(codes(result)).not.toContain("R003");
  });

  it("rejects native and compound target identifiers", () => {
    const portable = s.model({ id: s.string().id() });
    const native = s.model({ id: s.string(PG.STRING.UUID).id() });
    const compound = s
      .model({ tenantId: s.string(), localId: s.string() })
      .id(["tenantId", "localId"]);
    const nativeOwner = s.model({
      id: s.string().id(),
      target: s.toOne(
        { portable: () => portable, native: () => native },
        { values: { portable: "portable.v1", native: "native.v1" } }
      ),
    });
    const compoundOwner = s.model({
      id: s.string().id(),
      target: s.toOne(
        { portable: () => portable, compound: () => compound },
        { values: { portable: "portable.v1", compound: "compound.v1" } }
      ),
    });

    expect(
      codes(validateSchema({ portable, native, owner: nativeOwner }))
    ).toContain("P002");
    expect(
      codes(validateSchema({ portable, compound, owner: compoundOwner }))
    ).toContain("P009");
  });

  it("accepts a 63-character generated index and rejects 64", () => {
    const post = s.model({ id: s.string().id() });
    const relationAt63 = `r${"a".repeat(51)}`;
    const relationAt64 = `r${"a".repeat(52)}`;
    const accepted = s.model({
      id: s.string().id(),
      [relationAt63]: s.toOne(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });
    const rejected = s.model({
      id: s.string().id(),
      [relationAt64]: s.toOne(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });

    expect(codes(validateSchema({ post, o: accepted }))).not.toContain("P008");
    expect(codes(validateSchema({ post, o: rejected }))).toContain("P008");
  });

  it("uses serialized names for column, index, and constraint collisions", () => {
    const post = s.model({ id: s.string().id() });
    const relation = () =>
      s.toOne({ post: () => post }, { values: { post: "post.v1" } });
    const mappedColumnOwner = s.model({
      id: s.string().id(),
      shadow: s.string().map("target_type"),
      target: relation(),
    });
    const declaredIndexOwner = s
      .model({
        id: s.string().id(),
        shadow: s.string(),
        target: relation(),
      })
      .index(["shadow"], { name: "owner_target_poly_idx" });
    const unnamedIndexOwner = s
      .model({
        id: s.string().id(),
        target_poly: s.string(),
        target: relation(),
      })
      .index(["target_poly"]);
    const compoundIdOwner = s
      .model({
        tenantId: s.string(),
        localId: s.string(),
        target: relation(),
      })
      .id(["tenantId", "localId"], { name: "owner_target_poly_idx" });
    const compoundUniqueOwner = s
      .model({
        id: s.string().id(),
        tenantId: s.string(),
        localId: s.string(),
        target: relation(),
      })
      .unique(["tenantId", "localId"], { name: "owner_target_poly_idx" });

    expect(codes(validateSchema({ post, owner: mappedColumnOwner }))).toContain(
      "P008"
    );
    expect(
      codes(validateSchema({ post, owner: declaredIndexOwner }))
    ).toContain("P008");
    expect(codes(validateSchema({ post, owner: unnamedIndexOwner }))).toContain(
      "P008"
    );
    expect(
      codes(validateSchema({ post, owner: compoundIdOwner }))
    ).not.toContain("P008");
    expect(
      codes(validateSchema({ post, owner: compoundUniqueOwner }))
    ).not.toContain("P008");
  });

  it("keeps required self and mutual polymorphic schemas outside CM002", () => {
    const node = s.model({
      id: s.string().id(),
      parent: s.toOne({ node: () => node }, { values: { node: "node.v1" } }),
    });
    const left = s.model({
      id: s.string().id(),
      right: s.toOne({ right: () => right }, { values: { right: "right.v1" } }),
    });
    const right = s.model({
      id: s.string().id(),
      left: s.toOne({ left: () => left }, { values: { left: "left.v1" } }),
    });

    expect(codes(validateSchema({ node, left, right }))).not.toContain("CM002");
  });

  /**
   * RE-FOUNDED. HEAD ran the WHOLE rule list at client construction for a
   * polymorphic schema and only one rule for an ordinary one; there is no
   * "polymorphic schema" class left to special-case, so the two boundaries
   * became one — the structural gate, which §7.3 requires everywhere, plus the
   * schema-wide model identity a client needs to address a model at all.
   * Advice about how a schema is SPELLED stays with the boundary that writes
   * the column, exactly as it always did for an ordinary schema. The other
   * direction — running every rule here — would refuse schemas a client has
   * always built, and §9.4 enumerates no such break.
   */
  it("leaves advisory model rules to the boundary that writes DDL", () => {
    const invalidTarget = s.model({ id: s.string().id().nullable() });
    const owner = s.model({
      id: s.string().id(),
      target: s.toOne(
        { invalidTarget: () => invalidTarget },
        { values: { invalidTarget: "invalid-target.v1" } }
      ),
    });

    expect(() =>
      createClient({
        schema: { invalidTarget, owner },
        driver: new DefinitionDriver(),
      })
    ).not.toThrow();
    expect(() => validateSchemaOrThrow({ invalidTarget, owner })).toThrow(
      "[F006]"
    );
  });
});

describe("collection (toMany) definition rules", () => {
  /** Narrow a carrier edge to the member-junction arm these pins assert against. */
  function junctionCarrier(
    schema: Record<string, AnyModel>,
    model: AnyModel,
    field: string
  ) {
    const edge = carrierEdge(schema, model, field);
    return edge?.kind === "variantJunctionCarrier" ? edge : undefined;
  }

  /** One member of a junction carrier, by its public variant key. */
  function memberOf(edge: ReturnType<typeof junctionCarrier>, variant: string) {
    return edge?.members.find((entry) => entry.variant === variant);
  }

  it("refuses a member junction whose OWNER has no complete row key", () => {
    // The junction stores the owner's row key as its source columns, so an
    // owner with nothing to store is refused at the carrier (P018) — one issue
    // for the whole relation, not one per variant.
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const keyless = s.model({
      id: s.string(),
      attachments: s.toMany({ post: () => post, video: () => video }),
    });

    expect(codes(validateSchema({ post, video, keyless }))).toEqual([
      "P018",
      "M001",
    ]);
  });

  it("refuses only the MEMBER whose target has no complete row key", () => {
    // The target half is per variant, so a keyless target refuses its own
    // member (P009) and leaves its siblings resolvable.
    const post = s.model({ id: s.string().id() });
    const keylessTarget = s.model({ id: s.string() });
    const owner = s.model({
      id: s.string().id(),
      attachments: s.toMany({
        post: () => post,
        loose: () => keylessTarget,
      }),
    });

    expect(codes(validateSchema({ post, keylessTarget, owner }))).toEqual([
      "P009",
      "M001",
    ]);
  });

  it("counts no member names for a carrier whose targets are all unregistered", () => {
    // The name-counting prepass runs before the per-carrier resolution, and a
    // carrier that contributed no member endpoint must simply claim nothing —
    // not fail the prepass on a carrier the registration check already refused.
    const absent = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      attachments: s.toMany({ absent: () => absent }),
    });

    expect(codes(validateSchema({ owner }))).toEqual(["P001"]);
  });

  it("builds one trusted member-junction descriptor on a clean schema", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      items: s.toMany(
        { post: () => post, video: () => video },
        { values: { post: "items.post.v1", video: "items.video.v1" } }
      ),
    });

    const result = validateSchema({ post, video, owner });

    // §2.2 TOPOLOGY CELL 2 — a multi-variant collection, no inverses declared.
    // CLEAN: the descriptor exists and the serializer has DDL for it.
    expect(codes(result)).toEqual([]);
    const edge = junctionCarrier({ post, video, owner }, owner, "items");
    expect(edge).toMatchObject({
      kind: "variantJunctionCarrier",
      carrier: { source: owner, field: "items" },
    });
    const member = memberOf(edge, "post");
    expect(member).toMatchObject({
      variant: "post",
      entry: { storedValue: "items.post.v1" },
      // No inverse relation binds this member: the shareable default.
      uniqueTarget: false,
    });
    expect(member?.topology.target.model).toBe(post);
    expect(member?.topology.table).toBe("owner_items_post");
    expect(member?.topology.source).toMatchObject({
      model: owner,
      modelName: "owner",
      token: "ownerId",
    });
    expect(member?.topology.source.members).toEqual([
      { junctionField: "ownerId", referencedField: "id" },
    ]);
    expect(member?.topology.target).toMatchObject({
      model: post,
      modelName: "post",
      token: "postId",
    });
    expect(member?.topology.target.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
    expect(member?.topology.sourceIsFirst).toBe(true);
    expect(member?.topology.pairName).toBe("owner.items.post");
    expect(member?.topology.foreignKeyName("source")).toBe(
      "owner_items_post_ownerId_fkey"
    );
    expect(member?.topology.foreignKeyName("target")).toBe(
      "owner_items_post_postId_fkey"
    );
    expect(member?.topology.reverseIndexName()).toBe(
      "owner_items_post_postId_idx"
    );
    expect(memberOf(edge, "video")?.topology.table).toBe("owner_items_video");
  });

  it("expands a compound owner row key and honors .through() overrides", () => {
    const post = s.model({ id: s.string().id() });
    const owner = s
      .model({
        tenantId: s.string(),
        localId: s.string(),
        items: s
          .toMany(
            { post: () => post },
            { values: { post: "compound.post.v1" } }
          )
          .through({
            post: {
              table: "owner_collection",
              source: "holder",
              target: "entry",
            },
          }),
      })
      .id(["tenantId", "localId"]);

    const result = validateSchema({ post, owner });

    expect(codes(result)).toEqual([]);
    const member = memberOf(
      junctionCarrier({ post, owner }, owner, "items"),
      "post"
    );
    expect(member?.topology.table).toBe("owner_collection");
    expect(member?.topology.source.members).toEqual([
      { junctionField: "holder_1", referencedField: "tenantId" },
      { junctionField: "holder_2", referencedField: "localId" },
    ]);
    expect(member?.topology.target.members).toEqual([
      { junctionField: "entry", referencedField: "id" },
    ]);
  });

  it("accepts mixed and compound target row keys on a collection", () => {
    // §13.2: NO portable-representation check (P002) applies to a collection,
    // and a compound-id target is served through its complete row key where
    // the toOne arm refuses it (P009's single-scalar reading).
    const stringTarget = s.model({ id: s.string().id() });
    const intTarget = s.model({ id: s.int().id() });
    const compoundTarget = s
      .model({ tenantId: s.string(), localId: s.string() })
      .id(["tenantId", "localId"]);
    const owner = s.model({
      id: s.string().id(),
      items: s.toMany(
        {
          str: () => stringTarget,
          num: () => intTarget,
          pair: () => compoundTarget,
        },
        {
          values: {
            str: "mixed.str.v1",
            num: "mixed.num.v1",
            pair: "mixed.pair.v1",
          },
        }
      ),
    });

    const result = validateSchema({
      stringTarget,
      intTarget,
      compoundTarget,
      owner,
    });

    expect(codes(result)).toEqual([]);
    const edge = junctionCarrier(
      { stringTarget, intTarget, compoundTarget, owner },
      owner,
      "items"
    );
    expect(memberOf(edge, "pair")?.topology.target.members).toEqual([
      { junctionField: "pair_1", referencedField: "tenantId" },
      { junctionField: "pair_2", referencedField: "localId" },
    ]);
  });

  // A FORCED carrier (a plain object faking the internal surface) may answer
  // the schema-wide name prepass and the per-relation arm with DIFFERENT
  // target entries. The collision check must then treat the unseen member's
  // names as unclaimed (count 0), never crash or false-collide.
  it("rejects colliding member defaults across relations through the prepass", () => {
    const target = s.model({ id: s.string().id() });
    // Two DIFFERENT owners whose member defaults spell the same table:
    // `a` + `b_c` + `d` and `a_b` + `c` + `d` both derive `a_b_c_d`.
    const firstOwner = s.model({
      id: s.string().id(),
      b_c: s.toMany({ d: () => target }, { values: { d: "first.d.v1" } }),
    });
    const secondOwner = s.model({
      id: s.string().id(),
      c: s.toMany({ d: () => target }, { values: { d: "second.d.v1" } }),
    });

    const result = validateSchema({
      target,
      a: firstOwner,
      a_b: secondOwner,
    });

    expect(codes(result).filter((code) => code === "P019")).toHaveLength(2);
    const refusedSchema = { target, a: firstOwner, a_b: secondOwner };
    expect(carrierEdge(refusedSchema, firstOwner, "b_c")).toBeUndefined();
    expect(carrierEdge(refusedSchema, secondOwner, "c")).toBeUndefined();
  });

  it("rejects an over-length default table escaped by .through()", () => {
    const post = s.model({ id: s.string().id() });
    const longRelation = `r${"a".repeat(60)}`;
    const refused = s.model({
      id: s.string().id(),
      [longRelation]: s.toMany(
        { post: () => post },
        { values: { post: "long.post.v1" } }
      ),
    });
    const escaped = s.model({
      id: s.string().id(),
      [longRelation]: s
        .toMany({ post: () => post }, { values: { post: "long.post.v1" } })
        .through({
          post: { table: "short_table", source: "ownerId", target: "postId" },
        }),
    });

    expect(codes(validateSchema({ post, owner: refused }))).toEqual(["P019"]);
    expect(codes(validateSchema({ post, owner: escaped }))).toEqual([]);
  });

  it("maps junction physical-name refusals from token expansion to P019", () => {
    const post = s.model({ id: s.string().id() });
    const invalidToken = s.model({
      id: s.string().id(),
      items: s
        .toMany({ post: () => post }, { values: { post: "tok.post.v1" } })
        .through({
          post: {
            table: "owner_items_post",
            source: "has space",
            target: "postId",
          },
        }),
    });
    const equalTokens = s.model({
      id: s.string().id(),
      items: s
        .toMany({ post: () => post }, { values: { post: "eq.post.v1" } })
        .through({
          post: {
            table: "owner_items_post",
            source: "sharedRef",
            target: "sharedRef",
          },
        }),
    });

    expect(codes(validateSchema({ post, owner: invalidToken }))).toEqual([
      "P019",
    ]);
    expect(codes(validateSchema({ post, owner: equalTokens }))).toEqual([
      "P019",
    ]);
  });

  it("stores member-local inverse cardinalities side by side", () => {
    // §2.2 TOPOLOGY CELL 3 — shelf/book/video: one singular inverse, one
    // plural inverse, and an unbound member validate CLEAN, each member
    // keeping its own cardinality.
    const shelf = s.model({
      id: s.string().id(),
      items: s.toMany(
        { book: () => book, video: () => video, note: () => note },
        {
          values: {
            book: "shelf.book.v1",
            video: "shelf.video.v1",
            note: "shelf.note.v1",
          },
        }
      ),
    });
    const book = s.model({
      id: s.string().id(),
      shelf: s.toOne(() => shelf),
    });
    const video = s.model({
      id: s.string().id(),
      shelves: s.toMany(() => shelf),
    });
    const note = s.model({ id: s.string().id() });

    const result = validateSchema({ shelf, book, video, note });

    expect(codes(result)).toEqual([]);
    const edge = junctionCarrier({ shelf, book, video, note }, shelf, "items");
    expect(memberOf(edge, "book")?.uniqueTarget).toBe(true);
    expect(memberOf(edge, "video")?.uniqueTarget).toBe(false);
    expect(memberOf(edge, "note")?.uniqueTarget).toBe(false);
  });

  it("stops reserving phantom junction names for a polymorphic-bound manyToMany", () => {
    const member = s.model({
      id: s.string().id(),
      holders: s.toMany(() => phantomOwner),
    });
    const phantomOwner = s.model({
      id: s.string().id(),
      items: s
        .toMany({ m: () => member }, { values: { m: "phantom.m.v1" } })
        .through({
          m: { table: "member_owner", source: "ownerId", target: "memberId" },
        }),
    });

    // The bound manyToMany's PHANTOM ordinary junction would be the sorted
    // pair table `member_owner` — exactly this member's explicit table. With
    // the reservation skip the member validates clean; without it, P019
    // false-fires against the phantom.
    expect(codes(validateSchema({ member, owner: phantomOwner }))).toEqual([]);
  });

  /**
   * THE POSITIVE TWIN of the retained-shape tightening. Every negative pin
   * above measures a shape that stopped binding; this one measures the shapes
   * that DO bind, spelled the way Package C will read them, and demands the
   * whole schema come back clean. Without it the tightening could be
   * over-tight — refusing everything — and every negative pin would still
   * pass.
   *
   * The two C shapes are the complete set: a fields-less optional `manyToOne`
   * (the SINGULAR inverse — one owner per member row) and a fields-less
   * `manyToMany` (the PLURAL inverse — the shareable default). Their measured
   * consequence is the per-member `inverseCardinality`, which is what decides
   * whether the member table carries a unique constraint on its target side.
   */
  it("validates a collection whose inverses are exactly the two C shapes", () => {
    const article = s.model({
      id: s.string().id(),
      gallery: s.toOne(() => twinOwner),
    });
    const photo = s.model({
      id: s.string().id(),
      galleries: s.toMany(() => twinOwner),
    });
    const twinOwner = s.model({
      id: s.string().id(),
      items: s.toMany(
        { article: () => article, photo: () => photo },
        { values: { article: "twin.article.v1", photo: "twin.photo.v1" } }
      ),
    });

    const result = validateSchema({ article, photo, owner: twinOwner });

    // §2.2 TOPOLOGY CELL 4, and the strictest of the four: NOTHING at all —
    // no R003, no R004/R005, no junction rule, not even an FK warning.
    expect(codes(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);

    const edge = junctionCarrier(
      { article, photo, owner: twinOwner },
      twinOwner,
      "items"
    );
    expect(memberOf(edge, "article")).toMatchObject({ uniqueTarget: true });
    expect(memberOf(edge, "photo")).toMatchObject({ uniqueTarget: false });
  });

  /**
   * P020 — the half-pair the serializer's member-view exclusion would
   * otherwise let through. `tag.holders` binds the collection group, so no
   * ordinary junction is emitted for it; `hub.tags` binds nothing, so it emits
   * one ALONE. The schema means member-junction membership on one side and an
   * ordinary two-sided junction on the other.
   */
  /**
   * The other half of P020's coverage: when BOTH sides are member views (each
   * model carries a collection group the other's manyToMany binds), no
   * ordinary junction is emitted for either, so there is no half-pair and no
   * refusal. Without this, P020 could be a blanket "no manyToMany may face a
   * bound manyToMany" rule and the pin above would not notice.
   */
  /**
   * P021 — §6.3 ("an inverse of a `toMany` group is optional and clearable")
   * made true by construction.
   *
   * A SINGULAR collection inverse's removal verbs hang on `slotMayBeEmpty`, i.e.
   * on `.optional()` and on nothing else: `validation/relations/update.ts` reaches
   * the clearability owner only on the fields-less `oneToOne` branch, so the
   * `manyToMany` arm that would otherwise grant a junction-backed clear is never
   * consulted for this shape. Create-time requiredness does not fill the gap
   * either — `getFkRequirementKeySets` groups only fields-BEARING to-ones and
   * `toOne` polymorphic groups. Without this rule the declaration is silently
   * degraded into a slot that can be filled and never emptied.
   */
  it("accepts the same inverse once it is .optional()", () => {
    const page = s.model({
      id: s.string().id(),
      binder: s.toOne(() => binder),
    });
    const binder = s.model({
      id: s.string().id(),
      items: s.toMany(
        { page: () => page },
        { values: { page: "opt2.page.v1" } }
      ),
    });

    expect(codes(validateSchema({ page, binder }))).toEqual([]);
  });

  it("leaves the PLURAL inverse and the toOne group alone", () => {
    // A plural collection inverse clears by deleting its member-junction row,
    // so it never needed `.optional()`; and a `toOne` GROUP is
    // the row-held arm, whose requiredness is already answered by
    // `getFkRequirementKeySets`. Both must stay silent, or P021 would be a
    // blanket "every polymorphic inverse must be optional" rule and the pin above
    // would not notice.
    const clip = s.model({
      id: s.string().id(),
      binders: s.toMany(() => binder),
    });
    const badge = s.model({
      id: s.string().id(),
      holders: s.toMany(() => holder),
    });
    const binder = s.model({
      id: s.string().id(),
      items: s.toMany(
        { clip: () => clip },
        { values: { clip: "opt3.clip.v1" } }
      ),
    });
    const holder = s.model({
      id: s.string().id(),
      badge: s.toOne(
        { badge: () => badge },
        { values: { badge: "opt3.badge.v1" } }
      ),
    });

    expect(codes(validateSchema({ clip, badge, binder, holder }))).toEqual([]);
  });
});

describe("coverage low value", () => {
  it("visits asymmetric and multiply named junction storage", () => {
    // Every ordinary slot names its partner exactly: the reservation prepass
    // only runs over a schema that RESOLVES, so a fixture whose junctions do
    // not pair reserves nothing and visits none of this.
    const leftSide = s.model({
      id: s.string().id(),
      featured: s.toMany(() => rightSide).name("featured"),
      plain: s.toMany(() => rightSide).name("plain"),
    });
    const rightSide = s.model({
      id: s.string().id(),
      featured: s.toMany(() => leftSide).name("featured"),
      plain: s.toMany(() => leftSide).name("plain"),
    });
    const asymmetricLeft = s.model({
      id: s.string().id(),
      named: s.toMany(() => asymmetricRight).name("named"),
    });
    const asymmetricRight = s.model({
      id: s.string().id(),
      named: s.toMany(() => asymmetricLeft).name("named"),
    });
    const post = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      target: s.toOne({ post: () => post }),
    });

    expect(
      codes(
        validateSchema({
          leftSide,
          rightSide,
          asymmetricLeft,
          asymmetricRight,
          post,
          owner,
        })
      )
    ).toEqual([]);
  });

  it("visits covered and name-colliding automatic foreign-key indexes", () => {
    const parent = s.model({
      id: s.string().id(),
      tenant: s.string(),
      covered: s.toMany(() => owner).name("coveredParent"),
      fallbacks: s.toMany(() => owner).name("fallbackParent"),
      plains: s.toMany(() => owner).name("plainParent"),
      sole: s.toOne(() => owner).name("uniqueParent"),
    });
    const post = s.model({ id: s.string().id() });
    const owner = s
      .model({
        id: s.string().id(),
        // Covered by a declared index, so no automatic index is reserved.
        coveredParentId: s.string(),
        // Both candidate names are already taken by declared indexes.
        fallbackParentId: s.string(),
        // Neither candidate name is taken, so this one IS reserved.
        plainParentId: s.string(),
        // A ONE-to-one edge: the unique constraint already indexes it.
        uniqueParentId: s.string().unique(),
        spareA: s.string(),
        spareB: s.string(),
        coveredParent: s
          .toOne(() => parent)
          .name("coveredParent")
          .fields("coveredParentId")
          .references("id"),
        fallbackParent: s
          .toOne(() => parent)
          .name("fallbackParent")
          .fields("fallbackParentId")
          .references("id"),
        plainParent: s
          .toOne(() => parent)
          .name("plainParent")
          .fields("plainParentId")
          .references("id"),
        uniqueParent: s
          .toOne(() => parent)
          .name("uniqueParent")
          .fields("uniqueParentId")
          .references("id"),
        target: s.toOne({ post: () => post }),
      })
      .index(["coveredParentId"])
      .index(["spareA"], { name: "owner_fallbackParentId_idx" })
      .index(["spareB"], { name: "owner_fallbackParentId_fkey_idx" });

    expect(codes(validateSchema({ parent, post, owner }))).toEqual([]);
  });
});
