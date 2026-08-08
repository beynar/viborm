import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers";
import { PG, s } from "@src/schema";
import { PolymorphicRelation } from "@src/schema/relation";
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

  protected async closeClient() {}

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

describe("polymorphic definition rules", () => {
  it("builds one trusted private storage descriptor", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const commentable = s.polymorphic(
      { post: () => post, video: () => video },
      {
        values: {
          post: "content.post.v1",
          video: "content.video.v1",
        },
      }
    );
    const comment = s.model({ id: s.string().id(), commentable });

    const result = validateSchema({ post, video, comment });

    expect(result.errors).toEqual([]);
    expect(comment["~"].getPolymorphicStorage("commentable")).toMatchObject({
      relationName: "commentable",
      ownerModel: comment,
      indexName: "comment_commentable_poly_idx",
      typeColumn: { name: "commentable_type", nullable: false },
      idColumn: { name: "commentable_id", nullable: false },
    });
    expect([
      ...(comment["~"].getPolymorphicStorage("commentable")?.members ?? []),
    ]).toEqual([
      [
        "post",
        {
          storedType: "content.post.v1",
          targetModel: post,
          referencedField: "id",
        },
      ],
      [
        "video",
        {
          storedType: "content.video.v1",
          targetModel: video,
          referencedField: "id",
        },
      ],
    ]);
  });

  it("stores reused declarations per owner and field", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const target = s.polymorphic(
      { post: () => post, video: () => video },
      { values: { post: "post.v1", video: "video.v1" } }
    );
    const first = s.model({ id: s.string().id(), target });
    const second = s.model({ id: s.string().id(), subject: target });

    expect(validateSchema({ post, video, first }).errors).toEqual([]);
    const firstStorage = first["~"].getPolymorphicStorage("target");
    expect(validateSchema({ post, video, second }).errors).toEqual([]);

    expect(first["~"].getPolymorphicStorage("target")).toBe(firstStorage);
    expect(firstStorage?.indexName).toBe("first_target_poly_idx");
    expect(second["~"].getPolymorphicStorage("subject")?.indexName).toBe(
      "second_subject_poly_idx"
    );
  });

  it("rejects unregistered targets and missing primary keys", () => {
    const unregistered = s.model({ id: s.string().id() });
    const noPrimaryKey = s.model({ id: s.string() });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphic(
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
      mixed: s.polymorphic(
        { string: () => stringTarget, int: () => intTarget },
        { values: { string: "string.v1", int: "int.v1" } }
      ),
      array: s.polymorphic(
        { string: () => stringTarget, array: () => arrayTarget },
        { values: { string: "string.v1", array: "array.v1" } }
      ),
    });

    const result = validateSchema({ stringTarget, intTarget, arrayTarget, owner });

    expect(codes(result).filter((code) => code === "P002")).toHaveLength(2);
  });

  it("rejects invalid value maps and generated-name collisions", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const malformed = new PolymorphicRelation({
      type: "polymorphic",
      targets: { post: () => post, video: () => video },
      values: { post: "shared", video: "shared", extra: "extra" },
    });
    const owner = s.model({
      id: s.string().id(),
      target_type: s.string(),
      target: s.polymorphic(
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
      target: s.polymorphic(
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
        .polymorphic(
          { post: () => post, video: () => video },
          { values: { post: "post.v1", video: "video.v1" } }
        )
        .name("commentableTarget"),
    });

    expect(codes(validateSchema({ post, video, comment }))).not.toContain(
      "R003"
    );
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
        .polymorphic(
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
      first: s.polymorphic(
        { source: () => source, other: () => other },
        { values: { source: "first.source.v1", other: "first.other.v1" } }
      ),
      second: s.polymorphic(
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
      subject: s.polymorphic(
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
        .polymorphic(
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
        .polymorphic(
          { source: () => source },
          { values: { source: "source.first.v1" } }
        )
        .name("first"),
      second: s
        .polymorphic(
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
        .polymorphic(
          { source: () => separateSource },
          { values: { source: "source.v1" } }
        )
        .name("selected"),
      unrelated: s
        .polymorphic(
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
        .polymorphic(
          { source: () => missingSource },
          { values: { source: "source.first.v1" } }
        )
        .name("first"),
      second: s
        .polymorphic(
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
        .polymorphic(
          { source: () => ambiguousSource },
          { values: { source: "source.first.v1" } }
        )
        .name("shared"),
      second: s
        .polymorphic(
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
      duplicate: s.polymorphic(
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
        .polymorphic(
          { source: () => selectedSource },
          { values: { source: "source.selected.v1" } }
        )
        .name("selected"),
      unselectedDuplicate: s
        .polymorphic(
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
      target: s.polymorphic(targets, { values }),
    });

    const result = validateSchema({ post, owner });

    expect(codes(result)).not.toContain("P001");
    expect(codes(result)).not.toContain("P003");
    expect(owner["~"].getPolymorphicStorage("target")?.members.get("post"))
      .toMatchObject({ storedType: "post.v1", targetModel: post });
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
      target: Reflect.construct(PolymorphicRelation, [
        {
          type: "polymorphic",
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
      target: s.polymorphic(targets, { values }),
    });
    const nullValuesOwner = s.model({
      id: s.string().id(),
      target: Reflect.construct(PolymorphicRelation, [
        {
          type: "polymorphic",
          targets: { post: () => post },
          values: null,
        },
      ]),
    });

    expect(
      codes(validateSchema({ post, owner: nonPlainOwner }))
    ).toContain("P003");
    expect(
      codes(validateSchema({ post, owner: symbolicOwner }))
    ).toContain("P003");
    expect(
      codes(validateSchema({ post, owner: nullValuesOwner }))
    ).toContain("P003");
  });

  it("accepts 191-character stored values and rejects 192", () => {
    const post = s.model({ id: s.string().id() });
    const accepted = s.model({
      id: s.string().id(),
      target: s.polymorphic(
        { post: () => post },
        { values: { post: `v${"a".repeat(190)}` } }
      ),
    });
    const rejected = s.model({
      id: s.string().id(),
      target: s.polymorphic(
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
        target: s.polymorphic(targets, { values }),
      });
      expect(
        codes(validateSchema({ post, owner })),
        publicType
      ).toContain("P003");
    }
    const emptyTargets = s.model({
      id: s.string().id(),
      target: new PolymorphicRelation({
        type: "polymorphic",
        targets: {},
        values: {},
      }),
    });
    const emptyValue = s.model({
      id: s.string().id(),
      target: s.polymorphic(
        { post: () => post },
        { values: { post: "" } }
      ),
    });
    const duplicateValues = s.model({
      id: s.string().id(),
      target: s.polymorphic(
        { post: () => post, video: () => video },
        { values: { post: "shared.v1", video: "shared.v1" } }
      ),
    });

    const emptyResult = validateSchema({ owner: emptyTargets });
    expect(codes(emptyResult)).toContain("P007");
    expect(codes(validateSchema({ post, owner: emptyValue }))).toContain("P003");
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
      target: s.polymorphic(
        { portable: () => portable, native: () => native },
        { values: { portable: "portable.v1", native: "native.v1" } }
      ),
    });
    const compoundOwner = s.model({
      id: s.string().id(),
      target: s.polymorphic(
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
      [relationAt63]: s.polymorphic(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });
    const rejected = s.model({
      id: s.string().id(),
      [relationAt64]: s.polymorphic(
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
      s.polymorphic(
        { post: () => post },
        { values: { post: "post.v1" } }
      );
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

    expect(
      codes(validateSchema({ post, owner: mappedColumnOwner }))
    ).toContain("P008");
    expect(
      codes(validateSchema({ post, owner: declaredIndexOwner }))
    ).toContain("P008");
    expect(
      codes(validateSchema({ post, owner: unnamedIndexOwner }))
    ).toContain("P008");
    expect(codes(validateSchema({ post, owner: compoundIdOwner }))).not.toContain(
      "P008"
    );
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
      target: s.polymorphic(
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
      rights: s
        .manyToMany(() => right)
        .through("owner_target_poly_idx"),
    });
    const right = s.model({
      id: s.string().id(),
      lefts: s
        .manyToMany(() => left)
        .through("owner_target_poly_idx"),
    });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphic(
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
      target: s.polymorphic(
        { post: () => post },
        { values: { post: "post.v1" } }
      ),
    });

    expect(codes(validateSchema({ post, a, z, owner }))).toContain("P008");
  });

  it("keeps required self and mutual polymorphic schemas outside CM002", () => {
    const node = s.model({
      id: s.string().id(),
      parent: s.polymorphic(
        { node: () => node },
        { values: { node: "node.v1" } }
      ),
    });
    const left = s.model({
      id: s.string().id(),
      right: s.polymorphic(
        { right: () => right },
        { values: { right: "right.v1" } }
      ),
    });
    const right = s.model({
      id: s.string().id(),
      left: s.polymorphic(
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
      target: new PolymorphicRelation({
        type: "polymorphic",
        targets: { post: () => post },
        values: {},
      }),
    });

    expect(() =>
      createClient({ schema: { post, owner }, driver: new DefinitionDriver() })
    ).toThrow("[P003]");
  });

  it("runs prerequisite model rules at the mandatory client gate", () => {
    const invalidTarget = s.model({ id: s.string().id().nullable() });
    const owner = s.model({
      id: s.string().id(),
      target: s.polymorphic(
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
