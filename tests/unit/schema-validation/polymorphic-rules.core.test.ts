import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { PG, s } from "@src/schema";
import {
  type PolymorphicStorage,
  PolymorphicToManyRelation,
  PolymorphicToOneRelation,
} from "@src/schema/relation";
import { validateSchema } from "@src/schema/validation";
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

/** Narrow a storage read to the row-held toOne arm these pins assert against. */
function toOneStorage(storage: PolymorphicStorage | undefined) {
  return storage?.kind === "toOne" ? storage : undefined;
}

describe("polymorphic definition rules", () => {
  it("builds one trusted private storage descriptor", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const commentable = s.polymorphicToOne({
      post: () => post,
      video: () => video,
    });
    const comment = s.model({ id: s.string().id(), commentable });

    const result = validateSchema({ post, video, comment });

    expect(result.errors).toEqual([]);
    expect(comment["~"].getPolymorphicStorage("commentable")).toMatchObject({
      relationName: "commentable",
      ownerModel: comment,
      indexName: "comment_commentable_poly_idx",
      typeColumn: { name: "commentable_type", nullable: false },
      idColumn: { name: "commentable_id", nullable: false },
      inverseCardinality: "many",
    });
    expect([
      ...(comment["~"].getPolymorphicStorage("commentable")?.members ?? []),
    ]).toEqual([
      [
        "post",
        {
          storedType: "post",
          targetModel: post,
          referencedField: "id",
        },
      ],
      [
        "video",
        {
          storedType: "video",
          targetModel: video,
          referencedField: "id",
        },
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
      attachments: s.polymorphicToMany(
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
  it("attributes P013 to a forged carrier reached through an ordinary inverse", () => {
    // FORGED, not spelled: `s.polymorphicToOne` / `s.polymorphicToMany` each
    // stamp their own cardinality, so the public surface cannot build this
    // carrier at all. Only a hostile caller reaching the terminal's constructor
    // with a state that omits `cardinality` can, and the bare construct
    // signature is what lets this test be that caller.
    const ForgedCarrier: new (...args: never) => unknown =
      PolymorphicToOneRelation;
    const owner = s.model({
      id: s.string().id(),
      subject: Reflect.construct(ForgedCarrier, [
        {
          type: "polymorphic",
          targets: { catalog: () => catalog },
          values: { catalog: "catalog.v1" },
        },
      ]),
    });
    const catalog = s.model({
      id: s.string().id(),
      owners: s.oneToMany(() => owner),
    });

    const result = validateSchema({ catalog, owner });

    // R003 rides along since B3's retained-shape tightening
    // (`inverse.ts:getCompatiblePolymorphicInverseBinding`): the `oneToMany`
    // back-reference is a row-held shape, so it now binds ONLY a
    // `groupCardinality: "one"` group. This carrier is forged, yields no
    // cardinality at all, and therefore satisfies neither family — the
    // `oneToMany` is left with no inverse of any kind, which is exactly what
    // R003 reports. P013 still owns the carrier's own diagnosis; the two codes
    // are independent facts about the same hostile schema.
    expect(codes(result)).toEqual(["R003", "P013"]);
  });

  it("attributes R003 to a collection carrier reached through an ordinary inverse", () => {
    const owner = s.model({
      id: s.string().id(),
      subject: s.polymorphicToMany({ catalog: () => catalog }),
    });
    const catalog = s.model({
      id: s.string().id(),
      owners: s.oneToMany(() => owner),
    });

    const result = validateSchema({ catalog, owner });

    // R003 first, for the same reason as the forged-carrier twin above: the
    // retained `oneToMany` shape binds only toOne groups now, and this group is
    // a collection, so the back-reference has no inverse. The bind fell away as
    // a DELIBERATE consequence of the tightening, not as collateral — a
    // collection group's membership lives in member junctions, which a row-held
    // shape cannot address.
    expect(codes(result)).toEqual(["R003"]);
  });

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
  it("ejects a forged carrier before its content is diagnosed", () => {
    const target = s.model({ id: s.string().id() });
    const ForgedCarrier: new (...args: never) => unknown =
      PolymorphicToOneRelation;
    const owner = s.model({
      id: s.string().id(),
      subject: Reflect.construct(ForgedCarrier, [
        { type: "polymorphic", targets: { target: () => target }, values: {} },
      ]),
    });

    const result = validateSchema({ target, owner });

    expect(codes(result)).toEqual(["P013"]);
  });

  it("diagnoses a collection carrier's content with no appended refusal", () => {
    const target = s.model({ id: s.string().id() });
    const CollectionCarrier: new (...args: never) => unknown =
      PolymorphicToManyRelation;
    const owner = s.model({
      id: s.string().id(),
      subject: Reflect.construct(CollectionCarrier, [
        {
          type: "polymorphic",
          cardinality: "many",
          targets: { target: () => target },
          values: {},
        },
      ]),
    });

    const result = validateSchema({ target, owner });

    expect(codes(result)).toEqual(["P003"]);
  });

  // The snapshot is a DATA snapshot: every own property of `targets` and
  // `values` is read exactly once, at construction. A live accessor answering
  // validation with one value and storage with another is the dodge this pins —
  // before the data snapshot, this getter passed validation on its second read
  // while the storage descriptor kept the hostile first read.
  it("pins accessor-supplied stored values at construction", () => {
    const post = s.model({ id: s.string().id() });
    let reads = 0;
    const values = {
      get post(): string {
        reads += 1;
        return reads === 1 ? "### not a stored type ###" : "post";
      },
    };
    const owner = s.model({
      id: s.string().id(),
      commentable: s.polymorphicToOne({ post: () => post }, { values }),
    });

    expect(reads).toBe(1);
    const result = validateSchema({ post, owner });
    expect(codes(result)).toEqual(["P003"]);
    expect(reads).toBe(1);
  });

  it("stores reused declarations per owner and field", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const target = s.polymorphicToOne(
      { post: () => post, video: () => video },
      { values: { post: "post.v1", video: "video.v1" } }
    );
    const first = s.model({ id: s.string().id(), target });
    const second = s.model({ id: s.string().id(), subject: target });

    expect(validateSchema({ post, video, first }).errors).toEqual([]);
    const firstStorage = first["~"].getPolymorphicStorage("target");
    expect(validateSchema({ post, video, second }).errors).toEqual([]);

    expect(first["~"].getPolymorphicStorage("target")).toBe(firstStorage);
    expect(toOneStorage(firstStorage)?.indexName).toBe("first_target_poly_idx");
    expect(
      toOneStorage(second["~"].getPolymorphicStorage("subject"))?.indexName
    ).toBe("second_subject_poly_idx");
  });

  it("rejects unregistered targets and missing primary keys", () => {
    const unregistered = s.model({ id: s.string().id() });
    const noPrimaryKey = s.model({ id: s.string() });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
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

  it("rejects incompatible and array primary-key storage", () => {
    const stringTarget = s.model({ id: s.string().id() });
    const intTarget = s.model({ id: s.int().id() });
    const arrayTarget = s.model({ id: s.string().array().id() });
    const owner = s.model({
      id: s.string().id(),
      mixed: s.polymorphicToOne(
        { string: () => stringTarget, int: () => intTarget },
        { values: { string: "string.v1", int: "int.v1" } }
      ),
      array: s.polymorphicToOne(
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

  it("rejects invalid value maps and generated-name collisions", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const malformed = new PolymorphicToOneRelation({
      type: "polymorphic",
      cardinality: "one",
      targets: { post: () => post, video: () => video },
      values: { post: "shared", video: "shared", extra: "extra" },
    });
    const owner = s.model({
      id: s.string().id(),
      target_type: s.string(),
      target: s.polymorphicToOne(
        { post: () => post, video: () => video },
        { values: { post: "post.v1", video: "video.v1" } }
      ),
      malformed,
    });

    const result = validateSchema({ post, video, owner });

    expect(codes(result)).toContain("P003");
    expect(codes(result)).toContain("P008");
  });

  it("warns for a one-target relation without rejecting it", () => {
    const post = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });

    const result = validateSchema({ post, owner });

    expect(result.errors).toEqual([]);
    expect(warnings(result)).toContain("P011");
  });

  it("lets an ordinary inverse bind one polymorphic member", () => {
    const post = s.model({
      id: s.string().id(),
      comments: s.oneToMany(() => comment).name("commentableTarget"),
    });
    const video = s.model({ id: s.string().id() });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .polymorphicToOne(
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
      featuredComment: s
        .oneToOne(() => comment)
        .name("commentable")
        .optional(),
    });
    const video = s.model({
      id: s.string().id(),
      featuredComment: s
        .oneToOne(() => comment)
        .name("commentable")
        .optional(),
    });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .polymorphicToOne({ post: () => post, video: () => video })
        .name("commentable"),
    });

    const result = validateSchema({ post, video, comment });

    expect(result.errors).toEqual([]);
    expect(
      toOneStorage(comment["~"].getPolymorphicStorage("commentable"))
        ?.inverseCardinality
    ).toBe("one");
  });

  it("rejects mixed inverse cardinalities for one polymorphic storage", () => {
    const post = s.model({
      id: s.string().id(),
      comments: s.oneToMany(() => comment).name("commentable"),
    });
    const video = s.model({
      id: s.string().id(),
      featuredComment: s
        .oneToOne(() => comment)
        .name("commentable")
        .optional(),
    });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .polymorphicToOne({ post: () => post, video: () => video })
        .name("commentable"),
    });

    const result = validateSchema({ post, video, comment });

    expect(codes(result)).toContain("P012");
    expect(comment["~"].getPolymorphicStorage("commentable")).toBeUndefined();
  });

  it("applies a resolved singular cardinality to variants without inverses", () => {
    const post = s.model({
      id: s.string().id(),
      featuredComment: s
        .oneToOne(() => comment)
        .name("commentable")
        .optional(),
    });
    const video = s.model({ id: s.string().id() });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .polymorphicToOne({ post: () => post, video: () => video })
        .name("commentable"),
    });

    const result = validateSchema({ post, video, comment });

    expect(result.errors).toEqual([]);
    expect(
      toOneStorage(comment["~"].getPolymorphicStorage("commentable"))
        ?.inverseCardinality
    ).toBe("one");
  });

  it("keeps a fields-bearing one-to-one on the ordinary FK path", () => {
    const post = s.model({
      id: s.string().id(),
      commentId: s.string(),
      featuredComment: s
        .oneToOne(() => comment)
        .fields("commentId")
        .references("id")
        .name("commentable"),
    });
    const video = s.model({ id: s.string().id() });
    const comment = s.model({
      id: s.string().id(),
      commentable: s
        .polymorphicToOne({ post: () => post, video: () => video })
        .name("commentable"),
    });

    const result = validateSchema({ post, video, comment });

    expect(codes(result)).toContain("R002");
    expect(
      toOneStorage(comment["~"].getPolymorphicStorage("commentable"))
        ?.inverseCardinality
    ).toBe("many");
  });

  it("rejects one inverse name that selects both ordinary and polymorphic storage", () => {
    const source = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => child).name("shared"),
    });
    const other = s.model({ id: s.string().id() });
    const child = s.model({
      id: s.string().id(),
      sourceId: s.string(),
      source: s
        .manyToOne(() => source)
        .fields("sourceId")
        .references("id")
        .name("shared"),
      subject: s
        .polymorphicToOne(
          { source: () => source, other: () => other },
          { values: { source: "source.v1", other: "other.v1" } }
        )
        .name("shared"),
    });

    expect(codes(validateSchema({ source, other, child }))).toContain("P004");
  });

  it("keeps an ordinary inverse when unnamed polymorphic alternatives coexist", () => {
    const source = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => child),
    });
    const other = s.model({ id: s.string().id() });
    const child = s.model({
      id: s.string().id(),
      sourceId: s.string(),
      source: s
        .manyToOne(() => source)
        .fields("sourceId")
        .references("id"),
      first: s.polymorphicToOne(
        { source: () => source, other: () => other },
        { values: { source: "first.source.v1", other: "first.other.v1" } }
      ),
      second: s.polymorphicToOne(
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
      targets: s.oneToMany(() => target),
    });
    const video = s.model({ id: s.string().id() });
    const target = s.model({
      id: s.string().id(),
      subject: s.polymorphicToOne(
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
      targets: s.oneToMany(() => target).name("ordinaryName"),
    });
    const target = s.model({
      id: s.string().id(),
      source: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.v1" } }
        )
        .name("decorativeName"),
    });

    const result = validateSchema({ source, target });

    expect(codes(result)).not.toContain("P004");
    expect(codes(result)).not.toContain("P005");
    expect(codes(result)).not.toContain("P010");
    expect(codes(result)).not.toContain("R003");
  });

  it("requires a name when the target owns several polymorphic relations", () => {
    const source = s.model({
      id: s.string().id(),
      targets: s.oneToMany(() => target),
    });
    const target = s.model({
      id: s.string().id(),
      first: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.first.v1" } }
        )
        .name("first"),
      second: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.second.v1" } }
        )
        .name("second"),
    });

    expect(codes(validateSchema({ source, target }))).toContain("P005");

    const separateSource = s.model({
      id: s.string().id(),
      targets: s.oneToMany(() => separateTarget),
    });
    const unrelated = s.model({ id: s.string().id() });
    const separateTarget = s.model({
      id: s.string().id(),
      selected: s
        .polymorphicToOne(
          { source: () => separateSource },
          { values: { source: "source.v1" } }
        )
        .name("selected"),
      unrelated: s
        .polymorphicToOne(
          { unrelated: () => unrelated },
          { values: { unrelated: "unrelated.v1" } }
        )
        .name("unrelated"),
    });

    expect(
      codes(
        validateSchema({
          source: separateSource,
          unrelated,
          target: separateTarget,
        })
      )
    ).toContain("P005");
  });

  it("rejects missing and ambiguous inverse names", () => {
    const missingSource = s.model({
      id: s.string().id(),
      targets: s.oneToMany(() => missingTarget).name("missing"),
    });
    const missingTarget = s.model({
      id: s.string().id(),
      first: s
        .polymorphicToOne(
          { source: () => missingSource },
          { values: { source: "source.first.v1" } }
        )
        .name("first"),
      second: s
        .polymorphicToOne(
          { source: () => missingSource },
          { values: { source: "source.second.v1" } }
        )
        .name("second"),
    });
    const ambiguousSource = s.model({
      id: s.string().id(),
      targets: s.oneToMany(() => ambiguousTarget).name("shared"),
    });
    const ambiguousTarget = s.model({
      id: s.string().id(),
      first: s
        .polymorphicToOne(
          { source: () => ambiguousSource },
          { values: { source: "source.first.v1" } }
        )
        .name("shared"),
      second: s
        .polymorphicToOne(
          { source: () => ambiguousSource },
          { values: { source: "source.second.v1" } }
        )
        .name("shared"),
    });

    expect(
      codes(validateSchema({ source: missingSource, target: missingTarget }))
    ).toContain("P004");
    expect(
      codes(
        validateSchema({ source: ambiguousSource, target: ambiguousTarget })
      )
    ).toContain("P004");
  });

  it("rejects duplicates only in the selected inverse relation group", () => {
    const duplicateSource = s.model({
      id: s.string().id(),
      targets: s.oneToMany(() => duplicateTarget),
    });
    const duplicateTarget = s.model({
      id: s.string().id(),
      duplicate: s.polymorphicToOne(
        { first: () => duplicateSource, second: () => duplicateSource },
        {
          values: {
            first: "source.first.v1",
            second: "source.second.v1",
          },
        }
      ),
    });
    const selectedSource = s.model({
      id: s.string().id(),
      targets: s.oneToMany(() => selectedTarget).name("selected"),
    });
    const selectedTarget = s.model({
      id: s.string().id(),
      selected: s
        .polymorphicToOne(
          { source: () => selectedSource },
          { values: { source: "source.selected.v1" } }
        )
        .name("selected"),
      unselectedDuplicate: s
        .polymorphicToOne(
          { first: () => selectedSource, second: () => selectedSource },
          {
            values: {
              first: "source.first.v1",
              second: "source.second.v1",
            },
          }
        )
        .name("unselected"),
    });

    expect(
      codes(
        validateSchema({ source: duplicateSource, target: duplicateTarget })
      )
    ).toContain("P010");
    expect(
      codes(validateSchema({ source: selectedSource, target: selectedTarget }))
    ).not.toContain("P010");
  });

  it("accepts exact null-prototype and non-enumerable maps", () => {
    const post = s.model({ id: s.string().id() });
    const targets: Record<string, () => typeof post> = Object.create(null);
    const values: Record<string, string> = Object.create(null);
    Object.defineProperty(targets, "post", {
      configurable: true,
      value: () => post,
    });
    Object.defineProperty(values, "post", {
      configurable: true,
      value: "post.v1",
    });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(targets, { values }),
    });

    const result = validateSchema({ post, owner });

    expect(codes(result)).not.toContain("P001");
    expect(codes(result)).not.toContain("P003");
    expect(
      owner["~"].getPolymorphicStorage("target")?.members.get("post")
    ).toMatchObject({ storedType: "post.v1", targetModel: post });
  });

  it("rejects non-plain, symbolic, and inexact maps", () => {
    const post = s.model({ id: s.string().id() });
    class TargetMap {
      readonly post = () => post;
    }
    class ValueMap {
      readonly post = "post.v1";
    }
    const nonPlainOwner = s.model({
      id: s.string().id(),
      target: Reflect.construct(PolymorphicToOneRelation, [
        {
          type: "polymorphic",
          cardinality: "one",
          targets: new TargetMap(),
          values: new ValueMap(),
        },
      ]),
    });
    const targets = { post: () => post };
    const values = { post: "post.v1" };
    Object.defineProperty(targets, Symbol("hidden-target"), {
      value: () => post,
    });
    Object.defineProperty(values, Symbol("hidden-value"), {
      value: "hidden.v1",
    });
    const symbolicOwner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(targets, { values }),
    });
    const nullValuesOwner = s.model({
      id: s.string().id(),
      target: Reflect.construct(PolymorphicToOneRelation, [
        {
          type: "polymorphic",
          cardinality: "one",
          targets: { post: () => post },
          values: null,
        },
      ]),
    });

    expect(codes(validateSchema({ post, owner: nonPlainOwner }))).toContain(
      "P003"
    );
    expect(codes(validateSchema({ post, owner: symbolicOwner }))).toContain(
      "P003"
    );
    expect(codes(validateSchema({ post, owner: nullValuesOwner }))).toContain(
      "P003"
    );
  });

  it("accepts 191-character stored values and rejects 192", () => {
    const post = s.model({ id: s.string().id() });
    const accepted = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { post: () => post },
        { values: { post: `v${"a".repeat(190)}` } }
      ),
    });
    const rejected = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { post: () => post },
        { values: { post: `v${"a".repeat(191)}` } }
      ),
    });

    expect(codes(validateSchema({ post, owner: accepted }))).not.toContain(
      "P003"
    );
    expect(codes(validateSchema({ post, owner: rejected }))).toContain("P003");
  });

  it("rejects prototype keys, empty maps and values, and duplicate values", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    for (const publicType of Object.getOwnPropertyNames(Object.prototype)) {
      const targets: Record<string, () => typeof post> = Object.create(null);
      const values: Record<string, string> = Object.create(null);
      targets[publicType] = () => post;
      values[publicType] = "post.v1";
      const owner = s.model({
        id: s.string().id(),
        target: s.polymorphicToOne(targets, { values }),
      });
      expect(codes(validateSchema({ post, owner })), publicType).toContain(
        "P003"
      );
    }
    const emptyTargets = s.model({
      id: s.string().id(),
      target: new PolymorphicToOneRelation({
        type: "polymorphic",
        cardinality: "one",
        targets: {},
        values: {},
      }),
    });
    const emptyValue = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { post: () => post },
        { values: { post: "" } }
      ),
    });
    const duplicateValues = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { post: () => post, video: () => video },
        { values: { post: "shared.v1", video: "shared.v1" } }
      ),
    });

    const emptyResult = validateSchema({ owner: emptyTargets });
    expect(codes(emptyResult)).toContain("P007");
    expect(codes(validateSchema({ post, owner: emptyValue }))).toContain(
      "P003"
    );
    expect(
      codes(validateSchema({ post, video, owner: duplicateValues }))
    ).toContain("P003");
  });

  it("rejects native and compound target identifiers", () => {
    const portable = s.model({ id: s.string().id() });
    const native = s.model({ id: s.string(PG.STRING.UUID).id() });
    const compound = s
      .model({ tenantId: s.string(), localId: s.string() })
      .id(["tenantId", "localId"]);
    const nativeOwner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { portable: () => portable, native: () => native },
        { values: { portable: "portable.v1", native: "native.v1" } }
      ),
    });
    const compoundOwner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
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
      [relationAt63]: s.polymorphicToOne(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });
    const rejected = s.model({
      id: s.string().id(),
      [relationAt64]: s.polymorphicToOne(
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
      s.polymorphicToOne({ post: () => post }, { values: { post: "post.v1" } });
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

  it("reserves the automatic many-to-one foreign-key index name", () => {
    const post = s.model({ id: s.string().id() });
    const parent = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      target_poly: s.string(),
      parent: s
        .manyToOne(() => parent)
        .fields("target_poly")
        .references("id"),
      target: s.polymorphicToOne(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });

    expect(codes(validateSchema({ post, parent, owner }))).toContain("P008");
  });

  it("rejects a polymorphic index colliding with junction storage", () => {
    const post = s.model({ id: s.string().id() });
    const left = s.model({
      id: s.string().id(),
      rights: s.manyToMany(() => right).through("owner_target_poly_idx"),
    });
    const right = s.model({
      id: s.string().id(),
      lefts: s.manyToMany(() => left).through("owner_target_poly_idx"),
    });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });

    expect(codes(validateSchema({ post, left, right, owner }))).toContain(
      "P008"
    );
  });

  it("rejects a polymorphic index colliding with a junction reverse index", () => {
    const post = s.model({ id: s.string().id() });
    const a = s.model({
      id: s.string().id(),
      zs: s
        .manyToMany(() => z)
        .through("owner_target")
        .B("poly"),
    });
    const z = s.model({
      id: s.string().id(),
      as: s
        .manyToMany(() => a)
        .through("owner_target")
        .A("poly"),
    });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });

    expect(codes(validateSchema({ post, a, z, owner }))).toContain("P008");
  });

  it("keeps required self and mutual polymorphic schemas outside CM002", () => {
    const node = s.model({
      id: s.string().id(),
      parent: s.polymorphicToOne(
        { node: () => node },
        { values: { node: "node.v1" } }
      ),
    });
    const left = s.model({
      id: s.string().id(),
      right: s.polymorphicToOne(
        { right: () => right },
        { values: { right: "right.v1" } }
      ),
    });
    const right = s.model({
      id: s.string().id(),
      left: s.polymorphicToOne(
        { left: () => left },
        { values: { left: "left.v1" } }
      ),
    });

    expect(codes(validateSchema({ node, left, right }))).not.toContain("CM002");
  });

  it("uses the same rule owner at the mandatory client definition gate", () => {
    const post = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      target: new PolymorphicToOneRelation({
        type: "polymorphic",
        cardinality: "one",
        targets: { post: () => post },
        values: {},
      }),
    });

    expect(() =>
      createClient({ schema: { post, owner }, driver: new DefinitionDriver() })
    ).toThrow("[P003]");
  });

  it("rejects required ordinary inverses at client construction", () => {
    const parent = s.model({
      id: s.string().id(),
      child: s.oneToOne(() => child),
    });
    const child = s.model({
      id: s.string().id(),
      parentId: s.string().unique(),
      parent: s
        .oneToOne(() => parent)
        .fields("parentId")
        .references("id"),
    });

    expect(() =>
      createClient({
        schema: { parent, child },
        driver: new DefinitionDriver(),
      })
    ).toThrow("[R008]");
  });

  it("runs prerequisite model rules at the mandatory client gate", () => {
    const invalidTarget = s.model({ id: s.string().id().nullable() });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne(
        { invalidTarget: () => invalidTarget },
        { values: { invalidTarget: "invalid-target.v1" } }
      ),
    });

    expect(() =>
      createClient({
        schema: { invalidTarget, owner },
        driver: new DefinitionDriver(),
      })
    ).toThrow("[F006]");
  });
});

describe("collection (toMany) definition rules", () => {
  function toManyStorage(storage: PolymorphicStorage | undefined) {
    return storage?.kind === "toMany" ? storage : undefined;
  }

  it("builds one trusted member-junction descriptor on a clean schema", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { post: () => post, video: () => video },
        { values: { post: "items.post.v1", video: "items.video.v1" } }
      ),
    });

    const result = validateSchema({ post, video, owner });

    // §2.2 TOPOLOGY CELL 2 — a multi-variant collection, no inverses declared.
    // CLEAN: the descriptor exists and the serializer has DDL for it.
    expect(codes(result)).toEqual([]);
    const storage = toManyStorage(owner["~"].getPolymorphicStorage("items"));
    expect(storage).toMatchObject({
      kind: "toMany",
      relationName: "items",
      ownerModel: owner,
    });
    const member = storage?.members.get("post");
    expect(member).toMatchObject({
      publicType: "post",
      storedType: "items.post.v1",
      targetModel: post,
      // No inverse relation binds this member: the shareable default.
      inverseCardinality: "many",
    });
    expect(member?.junction.table).toBe("owner_items_post");
    expect(member?.junction.source).toMatchObject({
      model: owner,
      modelName: "owner",
      token: "ownerId",
    });
    expect(member?.junction.source.members).toEqual([
      { junctionField: "ownerId", referencedField: "id" },
    ]);
    expect(member?.junction.target).toMatchObject({
      model: post,
      modelName: "post",
      token: "postId",
    });
    expect(member?.junction.target.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
    expect(member?.junction.sourceIsFirst).toBe(true);
    expect(member?.junction.pairName).toBe("owner.items.post");
    expect(member?.junction.foreignKeyName("source")).toBe(
      "owner_items_post_ownerId_fkey"
    );
    expect(member?.junction.foreignKeyName("target")).toBe(
      "owner_items_post_postId_fkey"
    );
    expect(member?.junction.reverseIndexName()).toBe(
      "owner_items_post_postId_idx"
    );
    expect(storage?.members.get("video")?.junction.table).toBe(
      "owner_items_video"
    );
  });

  it("expands a compound owner row key and honors .through() overrides", () => {
    const post = s.model({ id: s.string().id() });
    const owner = s
      .model({
        tenantId: s.string(),
        localId: s.string(),
        items: s
          .polymorphicToMany(
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
    const member = toManyStorage(
      owner["~"].getPolymorphicStorage("items")
    )?.members.get("post");
    expect(member?.junction.table).toBe("owner_collection");
    expect(member?.junction.source.members).toEqual([
      { junctionField: "holder_1", referencedField: "tenantId" },
      { junctionField: "holder_2", referencedField: "localId" },
    ]);
    expect(member?.junction.target.members).toEqual([
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
      items: s.polymorphicToMany(
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
    const storage = toManyStorage(owner["~"].getPolymorphicStorage("items"));
    expect(storage?.members.get("pair")?.junction.target.members).toEqual([
      { junctionField: "pair_1", referencedField: "tenantId" },
      { junctionField: "pair_2", referencedField: "localId" },
    ]);
  });

  it("rejects malformed .through() maps with P017", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const CollectionCarrier: new (...args: never) => unknown =
      PolymorphicToManyRelation;
    const carrier = (through: unknown) =>
      Reflect.construct(CollectionCarrier, [
        {
          type: "polymorphic",
          cardinality: "many",
          targets: { post: () => post, video: () => video },
          values: { post: "through.post.v1", video: "through.video.v1" },
          through,
        },
      ]);
    const completeEntry = {
      table: "owner_items_post",
      source: "ownerRef",
      target: "postRef",
    };
    const videoEntry = {
      table: "owner_items_video",
      source: "ownerRef",
      target: "videoRef",
    };
    const missingVariant = s.model({
      id: s.string().id(),
      items: carrier({ post: completeEntry }),
    });
    const extraVariant = s.model({
      id: s.string().id(),
      items: carrier({
        post: completeEntry,
        video: videoEntry,
        extra: { table: "x", source: "y", target: "z" },
      }),
    });
    const missingEntryKey = s.model({
      id: s.string().id(),
      items: carrier({
        post: { table: "owner_items_post", target: "postRef" },
        video: videoEntry,
      }),
    });
    const nonStringTable = s.model({
      id: s.string().id(),
      items: carrier({
        post: { table: 42, source: "ownerRef", target: "postRef" },
        video: videoEntry,
      }),
    });
    const nonRecordMap = s.model({
      id: s.string().id(),
      items: carrier(42),
    });
    const wellFormed = s.model({
      id: s.string().id(),
      items: carrier({ post: completeEntry, video: videoEntry }),
    });

    for (const owner of [
      missingVariant,
      extraVariant,
      missingEntryKey,
      nonStringTable,
      nonRecordMap,
    ]) {
      expect(codes(validateSchema({ post, video, owner }))).toEqual(["P017"]);
    }
    expect(codes(validateSchema({ post, video, owner: wellFormed }))).toEqual(
      []
    );
  });

  it("rejects non-getter and unregistered collection targets with P001", () => {
    const CollectionCarrier: new (...args: never) => unknown =
      PolymorphicToManyRelation;
    const badGetterOwner = s.model({
      id: s.string().id(),
      items: Reflect.construct(CollectionCarrier, [
        {
          type: "polymorphic",
          cardinality: "many",
          targets: { bad: 42 },
          values: { bad: "p1.bad.v1" },
        },
      ]),
    });
    expect(codes(validateSchema({ owner: badGetterOwner }))).toEqual(["P001"]);

    const unregistered = s.model({ id: s.string().id() });
    const unregisteredOwner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { absent: () => unregistered },
        { values: { absent: "p1.absent.v1" } }
      ),
    });
    expect(codes(validateSchema({ owner: unregisteredOwner }))).toEqual([
      "P001",
    ]);

    const nonModelOwner = s.model({
      id: s.string().id(),
      items: Reflect.construct(CollectionCarrier, [
        {
          type: "polymorphic",
          cardinality: "many",
          targets: { odd: () => 42 },
          values: { odd: "p1.odd.v1" },
        },
      ]),
    });
    expect(codes(validateSchema({ owner: nonModelOwner }))).toEqual(["P001"]);
  });

  // A FORCED carrier (a plain object faking the internal surface) may answer
  // the schema-wide name prepass and the per-relation arm with DIFFERENT
  // target entries. The collision check must then treat the unseen member's
  // names as unclaimed (count 0), never crash or false-collide.
  it("survives a forced carrier whose target entries flip between reads", () => {
    const post = s.model({ id: s.string().id() });
    let reads = 0;
    const entry = {
      publicType: "post",
      targetGetter: () => post,
      targetModel: post,
      storedType: "flip.post.v1",
    };
    const flippingCarrier = {
      "~": {
        state: {
          type: "polymorphic",
          cardinality: "many",
          targets: { post: () => post },
          values: { post: "flip.post.v1" },
        },
        targetEntries: () => {
          reads += 1;
          // The schema-wide prepass runs once per MODEL validation (twice for
          // this two-model schema); only the per-relation content read (#3)
          // sees the member, so its names carry no prepass claim at all.
          return reads >= 3 ? [entry] : [];
        },
      },
    };
    const owner = s.model({
      id: s.string().id(),
      items: flippingCarrier as never,
    });

    const result = validateSchema({ post, owner });

    expect(codes(result)).toEqual([]);
    expect(owner["~"].getPolymorphicStorage("items")?.kind).toBe("toMany");
  });

  it("requires a complete owner row key with P018", () => {
    const post = s.model({ id: s.string().id() });
    const keylessOwner = s.model({
      id: s.string(),
      items: s.polymorphicToMany(
        { post: () => post },
        { values: { post: "p18.post.v1" } }
      ),
    });

    const result = validateSchema({ post, owner: keylessOwner });

    // M001 is the model's own missing-id diagnosis; P018 is the relation's.
    expect(codes(result)).toEqual(["M001", "P018"]);
    expect(keylessOwner["~"].getPolymorphicStorage("items")).toBeUndefined();
  });

  it("requires a complete target row key with P009's collection reading", () => {
    const keylessTarget = s.model({ id: s.string() });
    const owner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { bad: () => keylessTarget },
        { values: { bad: "p9.bad.v1" } }
      ),
    });

    const result = validateSchema({ keylessTarget, owner });

    // M001 is the target model's own missing-id diagnosis.
    expect(codes(result)).toEqual(["M001", "P009"]);
    expect(owner["~"].getPolymorphicStorage("items")).toBeUndefined();
  });

  it("rejects member names colliding with model tables and ordinary junctions", () => {
    const post = s.model({ id: s.string().id() });
    const shadow = s.model({ id: s.string().id() }).map("owner_items_post");
    const tableCollision = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { post: () => post },
        { values: { post: "t.post.v1" } }
      ),
    });
    expect(
      codes(validateSchema({ post, shadow, owner: tableCollision }))
    ).toEqual(["P019"]);
    expect(tableCollision["~"].getPolymorphicStorage("items")).toBeUndefined();

    const columnCollision = s.model({
      id: s.string().id(),
      reserved_name: s.string(),
      items: s
        .polymorphicToMany(
          { post: () => post },
          { values: { post: "c.post.v1" } }
        )
        .through({
          post: { table: "reserved_name", source: "ownerId", target: "postId" },
        }),
    });
    expect(codes(validateSchema({ post, owner: columnCollision }))).toEqual([
      "P019",
    ]);

    const alpha = s.model({
      id: s.string().id(),
      zetas: s.manyToMany(() => zeta).through("shared_junction"),
    });
    const zeta = s.model({
      id: s.string().id(),
      alphas: s.manyToMany(() => alpha).through("shared_junction"),
    });
    const junctionCollision = s.model({
      id: s.string().id(),
      items: s
        .polymorphicToMany(
          { post: () => post },
          { values: { post: "j.post.v1" } }
        )
        .through({
          post: {
            table: "shared_junction",
            source: "ownerId",
            target: "postId",
          },
        }),
    });
    expect(
      codes(validateSchema({ post, alpha, zeta, owner: junctionCollision }))
    ).toEqual(["P019"]);

    const reverseIndexCollision = s.model({
      id: s.string().id(),
      items: s
        .polymorphicToMany(
          { post: () => post },
          { values: { post: "r.post.v1" } }
        )
        .through({
          post: {
            table: "shared_junction_zetaId_idx",
            source: "ownerId",
            target: "postId",
          },
        }),
    });
    expect(
      codes(validateSchema({ post, alpha, zeta, owner: reverseIndexCollision }))
    ).toEqual(["P019"]);
  });

  it("rejects colliding member defaults across relations through the prepass", () => {
    const target = s.model({ id: s.string().id() });
    // Two DIFFERENT owners whose member defaults spell the same table:
    // `a` + `b_c` + `d` and `a_b` + `c` + `d` both derive `a_b_c_d`.
    const firstOwner = s.model({
      id: s.string().id(),
      b_c: s.polymorphicToMany(
        { d: () => target },
        { values: { d: "first.d.v1" } }
      ),
    });
    const secondOwner = s.model({
      id: s.string().id(),
      c: s.polymorphicToMany(
        { d: () => target },
        { values: { d: "second.d.v1" } }
      ),
    });

    const result = validateSchema({
      target,
      a: firstOwner,
      a_b: secondOwner,
    });

    expect(codes(result).filter((code) => code === "P019")).toHaveLength(2);
    expect(firstOwner["~"].getPolymorphicStorage("b_c")).toBeUndefined();
    expect(secondOwner["~"].getPolymorphicStorage("c")).toBeUndefined();
  });

  it("rejects an over-length default table escaped by .through()", () => {
    const post = s.model({ id: s.string().id() });
    const longRelation = `r${"a".repeat(60)}`;
    const refused = s.model({
      id: s.string().id(),
      [longRelation]: s.polymorphicToMany(
        { post: () => post },
        { values: { post: "long.post.v1" } }
      ),
    });
    const escaped = s.model({
      id: s.string().id(),
      [longRelation]: s
        .polymorphicToMany(
          { post: () => post },
          { values: { post: "long.post.v1" } }
        )
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
        .polymorphicToMany(
          { post: () => post },
          { values: { post: "tok.post.v1" } }
        )
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
        .polymorphicToMany(
          { post: () => post },
          { values: { post: "eq.post.v1" } }
        )
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

  it("rejects a member bound by more than one inverse relation with P015", () => {
    const owner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { member: () => member },
        { values: { member: "p15.member.v1" } }
      ),
    });
    const member = s.model({
      id: s.string().id(),
      first: s.manyToOne(() => owner).optional(),
      second: s.manyToOne(() => owner).optional(),
    });

    const result = validateSchema({ owner, member });

    expect(codes(result)).toEqual(["P015"]);
    expect(owner["~"].getPolymorphicStorage("items")).toBeUndefined();
  });

  it("stores member-local inverse cardinalities side by side", () => {
    // §2.2 TOPOLOGY CELL 3 — shelf/book/video: one singular inverse, one
    // plural inverse, and an unbound member validate CLEAN, each member
    // keeping its own cardinality.
    const shelf = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
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
      shelf: s.manyToOne(() => shelf).optional(),
    });
    const video = s.model({
      id: s.string().id(),
      shelves: s.manyToMany(() => shelf),
    });
    const note = s.model({ id: s.string().id() });

    const result = validateSchema({ shelf, book, video, note });

    expect(codes(result)).toEqual([]);
    const storage = toManyStorage(shelf["~"].getPolymorphicStorage("items"));
    expect(storage?.members.get("book")?.inverseCardinality).toBe("one");
    expect(storage?.members.get("video")?.inverseCardinality).toBe("many");
    expect(storage?.members.get("note")?.inverseCardinality).toBe("many");
  });

  it("refuses physical modifiers on a polymorphic-bound manyToMany with P016", () => {
    const modified = s.model({
      id: s.string().id(),
      holders: s.manyToMany(() => modifiedOwner).through("explicit_table"),
    });
    const modifiedOwner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { member: () => modified },
        { values: { member: "p16.member.v1" } }
      ),
    });
    const plain = s.model({
      id: s.string().id(),
      holders: s.manyToMany(() => plainOwner),
    });
    const plainOwner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { member: () => plain },
        { values: { member: "p16.plain.v1" } }
      ),
    });

    const modifiedResult = validateSchema({
      member: modified,
      owner: modifiedOwner,
    });
    expect(codes(modifiedResult)).toContain("P016");

    expect(codes(validateSchema({ member: plain, owner: plainOwner }))).toEqual(
      []
    );
  });

  it("keeps an unbound manyToMany .through() on the ordinary junction rules", () => {
    const alpha = s.model({
      id: s.string().id(),
      zetas: s.manyToMany(() => zeta).through("plain_junction"),
    });
    const zeta = s.model({
      id: s.string().id(),
      alphas: s.manyToMany(() => alpha).through("plain_junction"),
    });

    const result = validateSchema({ alpha, zeta });

    expect(codes(result)).not.toContain("P016");
    expect(result.errors).toEqual([]);
  });

  it("extends R008 to a required manyToOne bound to a collection member", () => {
    const requiredMember = s.model({
      id: s.string().id(),
      holder: s.manyToOne(() => requiredOwner),
    });
    const requiredOwner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { member: () => requiredMember },
        { values: { member: "r8.member.v1" } }
      ),
    });
    const optionalMember = s.model({
      id: s.string().id(),
      holder: s.manyToOne(() => optionalOwner).optional(),
    });
    const optionalOwner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { member: () => optionalMember },
        { values: { member: "r8.optional.v1" } }
      ),
    });

    const requiredResult = validateSchema({
      member: requiredMember,
      owner: requiredOwner,
    });
    expect(codes(requiredResult)).toContain("R008");
    expect(
      requiredResult.errors.find((entry) => entry.code === "R008")?.message
    ).toBe(
      "Non-owning many-to-one 'holder' in 'member' must call .optional() because its membership lives in a polymorphic member junction."
    );

    const optionalResult = validateSchema({
      member: optionalMember,
      owner: optionalOwner,
    });
    expect(codes(optionalResult)).toEqual([]);
    expect(warnings(optionalResult)).not.toContain("FK004");
  });

  it("keeps the ordinary-compat manyToOne on R004 and FK004", () => {
    const parent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => child),
    });
    const child = s.model({
      id: s.string().id(),
      parent: s.manyToOne(() => parent),
    });

    const result = validateSchema({ parent, child });

    // The binding never resolves on an ordinary target, so the required
    // fields-less compat form keeps today's diagnostics untouched.
    expect(codes(result)).not.toContain("R008");
    expect(warnings(result)).toContain("FK004");
  });

  it("falls back to R004 for a fields-less manyToOne over a toOne group", () => {
    const singularOwner = s.model({
      id: s.string().id(),
      item: s.polymorphicToOne(
        { member: () => singularMember },
        { values: { member: "fallback.member.v1" } }
      ),
    });
    const singularMember = s.model({
      id: s.string().id(),
      holder: s.manyToOne(() => singularOwner).optional(),
    });

    const result = validateSchema({
      owner: singularOwner,
      member: singularMember,
    });

    // The projection refuses the binding, so the ordinary meaning stands:
    // missing inverse (R004), no P012 flip, and the toOne descriptor keeps its
    // relation-wide cardinality untouched.
    expect(codes(result)).toContain("R004");
    expect(codes(result)).not.toContain("P012");
    expect(singularOwner["~"].getPolymorphicStorage("item")).toMatchObject({
      kind: "toOne",
      inverseCardinality: "many",
    });
  });

  it("widens P010 to duplicate variants reached through junction-shaped inverses", () => {
    const cleanTarget = s.model({ id: s.string().id() });
    const duplicateOnly = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { first: () => cleanTarget, second: () => cleanTarget },
        { values: { first: "dup.first.v1", second: "dup.second.v1" } }
      ),
    });
    expect(
      codes(validateSchema({ cleanTarget, owner: duplicateOnly }))
    ).toEqual([]);

    const boundTarget = s.model({
      id: s.string().id(),
      holder: s.manyToOne(() => duplicateBound).optional(),
    });
    const duplicateBound = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { first: () => boundTarget, second: () => boundTarget },
        { values: { first: "dupb.first.v1", second: "dupb.second.v1" } }
      ),
    });
    const boundResult = validateSchema({
      target: boundTarget,
      owner: duplicateBound,
    });
    expect(codes(boundResult)).toContain("P010");
  });

  it("extends the P004 named-collision treatment to junction-shaped inverses", () => {
    const collisionOwner = s.model({
      id: s.string().id(),
      favoriteId: s.string(),
      items: s
        .polymorphicToMany(
          { member: () => collisionMember },
          { values: { member: "p4.member.v1" } }
        )
        .name("shared"),
      favorite: s
        .manyToOne(() => collisionMember)
        .fields("favoriteId")
        .references("id")
        .name("shared"),
    });
    const collisionMember = s.model({
      id: s.string().id(),
      holder: s
        .manyToOne(() => collisionOwner)
        .optional()
        .name("shared"),
      owners: s.oneToMany(() => collisionOwner).name("shared"),
    });

    expect(
      codes(validateSchema({ owner: collisionOwner, member: collisionMember }))
    ).toContain("P004");
  });

  it("stops reserving phantom junction names for a polymorphic-bound manyToMany", () => {
    const member = s.model({
      id: s.string().id(),
      holders: s.manyToMany(() => phantomOwner),
    });
    const phantomOwner = s.model({
      id: s.string().id(),
      items: s
        .polymorphicToMany(
          { m: () => member },
          { values: { m: "phantom.m.v1" } }
        )
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
      gallery: s.manyToOne(() => twinOwner).optional(),
    });
    const photo = s.model({
      id: s.string().id(),
      galleries: s.manyToMany(() => twinOwner),
    });
    const twinOwner = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { article: () => article, photo: () => photo },
        { values: { article: "twin.article.v1", photo: "twin.photo.v1" } }
      ),
    });

    const result = validateSchema({ article, photo, owner: twinOwner });

    // §2.2 TOPOLOGY CELL 4, and the strictest of the four: NOTHING at all —
    // no R003, no R004/R005, no junction rule, not even an FK warning.
    expect(codes(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);

    const storage = toManyStorage(
      twinOwner["~"].getPolymorphicStorage("items")
    );
    expect(storage?.members.get("article")).toMatchObject({
      inverseCardinality: "one",
    });
    expect(storage?.members.get("photo")).toMatchObject({
      inverseCardinality: "many",
    });
  });

  /**
   * P020 — the half-pair the serializer's member-view exclusion would
   * otherwise let through. `tag.holders` binds the collection group, so no
   * ordinary junction is emitted for it; `hub.tags` binds nothing, so it emits
   * one ALONE. The schema means member-junction membership on one side and an
   * ordinary two-sided junction on the other.
   */
  it("refuses a polymorphic member view paired with an ordinary junction side", () => {
    const tag = s.model({
      id: s.string().id(),
      holders: s.manyToMany(() => hub),
    });
    const hub = s.model({
      id: s.string().id(),
      tags: s.manyToMany(() => tag),
      items: s.polymorphicToMany(
        { tag: () => tag },
        { values: { tag: "half.tag.v1" } }
      ),
    });

    const result = validateSchema({ tag, hub });

    expect(codes(result)).toContain("P020");
    expect(result.errors.find((entry) => entry.code === "P020")).toMatchObject({
      model: "tag",
      relation: "holders",
    });
  });

  /**
   * The other half of P020's coverage: when BOTH sides are member views (each
   * model carries a collection group the other's manyToMany binds), no
   * ordinary junction is emitted for either, so there is no half-pair and no
   * refusal. Without this, P020 could be a blanket "no manyToMany may face a
   * bound manyToMany" rule and the pin above would not notice.
   */
  it("accepts two member views facing each other", () => {
    const leftHub = s.model({
      id: s.string().id(),
      rights: s.manyToMany(() => rightHub),
      items: s.polymorphicToMany(
        { right: () => rightHub },
        { values: { right: "mirror.right.v1" } }
      ),
    });
    const rightHub = s.model({
      id: s.string().id(),
      lefts: s.manyToMany(() => leftHub),
      items: s.polymorphicToMany(
        { left: () => leftHub },
        { values: { left: "mirror.left.v1" } }
      ),
    });

    expect(codes(validateSchema({ leftHub, rightHub }))).toEqual([]);
  });

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
  it("refuses a NON-optional singular collection inverse with P021", () => {
    const page = s.model({
      id: s.string().id(),
      binder: s.manyToOne(() => binder),
    });
    const binder = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { page: () => page },
        { values: { page: "opt.page.v1" } }
      ),
    });

    const result = validateSchema({ page, binder });

    expect(codes(result)).toContain("P021");
    expect(result.errors.find((entry) => entry.code === "P021")).toMatchObject({
      model: "page",
      relation: "binder",
    });
  });

  it("accepts the same inverse once it is .optional()", () => {
    const page = s.model({
      id: s.string().id(),
      binder: s.manyToOne(() => binder).optional(),
    });
    const binder = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { page: () => page },
        { values: { page: "opt2.page.v1" } }
      ),
    });

    expect(codes(validateSchema({ page, binder }))).toEqual([]);
  });

  it("leaves the PLURAL inverse and the toOne group alone", () => {
    // A `manyToMany` inverse clears through `state.type === "manyToMany"` in the
    // to-many factory, so it never needed `.optional()`; and a `toOne` GROUP is
    // the row-held arm, whose requiredness is already answered by
    // `getFkRequirementKeySets`. Both must stay silent, or P021 would be a
    // blanket "every polymorphic inverse must be optional" rule and the pin above
    // would not notice.
    const clip = s.model({
      id: s.string().id(),
      binders: s.manyToMany(() => binder),
    });
    const badge = s.model({
      id: s.string().id(),
      holders: s.oneToMany(() => holder),
    });
    const binder = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany(
        { clip: () => clip },
        { values: { clip: "opt3.clip.v1" } }
      ),
    });
    const holder = s.model({
      id: s.string().id(),
      badge: s.polymorphicToOne(
        { badge: () => badge },
        { values: { badge: "opt3.badge.v1" } }
      ),
    });

    expect(codes(validateSchema({ clip, badge, binder, holder }))).toEqual([]);
  });
});

describe("coverage low value", () => {
  it("visits asymmetric and multiply named junction storage", () => {
    const left = s.model({
      id: s.string().id(),
      featured: s.manyToMany(() => right).name("featured"),
    });
    const right = s.model({
      id: s.string().id(),
      featured: s.manyToMany(() => left).name("featured"),
      unnamed: s.manyToMany(() => left),
    });
    const asymmetricLeft = s.model({
      id: s.string().id(),
      named: s.manyToMany(() => asymmetricRight).name("named"),
    });
    const asymmetricRight = s.model({
      id: s.string().id(),
      unnamed: s.manyToMany(() => asymmetricLeft),
    });
    const post = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphicToOne({ post: () => post }),
    });

    expect(
      codes(
        validateSchema({
          left,
          right,
          asymmetricLeft,
          asymmetricRight,
          post,
          owner,
        })
      )
    ).not.toContain("P008");
  });

  it("visits covered and name-colliding automatic foreign-key indexes", () => {
    const parent = s.model({ id: s.string().id() });
    const post = s.model({ id: s.string().id() });
    const owner = s
      .model({
        id: s.string().id(),
        coveredParentId: s.string().unique(),
        fallbackParentId: s.string(),
        spareA: s.string(),
        spareB: s.string(),
        coveredParent: s
          .manyToOne(() => parent)
          .fields("coveredParentId")
          .references("id"),
        fallbackParent: s
          .manyToOne(() => parent)
          .fields("fallbackParentId")
          .references("id"),
        target: s.polymorphicToOne({ post: () => post }),
      })
      .index(["spareA"], { name: "owner_fallbackParentId_idx" })
      .index(["spareB"], { name: "owner_fallbackParentId_fkey_idx" });

    expect(codes(validateSchema({ parent, post, owner }))).not.toContain(
      "P008"
    );
  });

  it("fails closed for unregistered inverse targets and malformed getters", () => {
    const missing = s.model({ id: s.string().id() });
    const source = s.model({
      id: s.string().id(),
      missing: s.oneToOne(() => missing).optional(),
    });
    const malformedOwner = s.model({
      id: s.string().id(),
      target: Reflect.construct(PolymorphicToOneRelation, [
        {
          type: "polymorphic",
          cardinality: "one",
          targets: { malformed: 42 },
          values: { malformed: "malformed" },
        },
      ]),
    });

    expect(codes(validateSchema({ source }))).toContain("R006");
    expect(codes(validateSchema({ malformedOwner }))).toContain("P001");
  });
});
