import {
  getPolymorphicInverseBinding,
  hydrateSchemaNames,
  s,
} from "@src/schema";
import {
  getPolymorphicInverseCandidates,
  isPolymorphicRelation,
  PolymorphicToOneRelation,
} from "@src/schema/relation";
import { describe, expect, it } from "vitest";

const THROUGH_MAP = {
  post: {
    table: "owner_items_post",
    source: "ownerRef",
    target: "postRef",
  },
  video: {
    table: "owner_items_video",
    source: "ownerRef",
    target: "videoRef",
  },
} as const;

describe("polymorphic relation carrier", () => {
  it("defaults stored discriminators to the public target keys", () => {
    let targetReads = 0;
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const relation = s.polymorphicToOne({
      post: () => {
        targetReads += 1;
        return post;
      },
      video: () => {
        targetReads += 1;
        return video;
      },
    });

    expect(relation["~"].state.values).toEqual({
      post: "post",
      video: "video",
    });
    expect(Object.isFrozen(relation["~"].state.values)).toBe(true);
    expect(targetReads).toBe(0);
    expect(relation["~"].targetEntries()).toEqual([
      {
        publicType: "post",
        targetGetter: expect.any(Function),
        targetModel: post,
        storedType: "post",
      },
      {
        publicType: "video",
        targetGetter: expect.any(Function),
        targetModel: video,
        storedType: "video",
      },
    ]);
  });

  it("keeps polymorphic fields separate from scalars and ordinary relations", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const commentable = s
      .polymorphicToOne(
        { post: () => post, video: () => video },
        {
          values: {
            post: "content.post.v1",
            video: "content.video.v1",
          },
        }
      )
      .name("commentableTarget")
      .optional();
    const comment = s.model({
      id: s.string().id(),
      commentable,
    });

    expect(comment["~"].state.scalars).toEqual({ id: expect.anything() });
    expect(comment["~"].state.relations).toEqual({});
    expect(comment["~"].state.polymorphicRelations).toEqual({ commentable });
    expect(comment["~"].scalarFieldNames).toEqual(["id"]);
    expect(comment["~"].relationNames).toEqual([]);
    expect(comment["~"].polymorphicRelationNames).toEqual(["commentable"]);
  });

  it("hydrates the field name without resolving target getters", () => {
    let targetReads = 0;
    const post = s.model({ id: s.string().id() });
    const commentable = s.polymorphicToOne(
      {
        post: () => {
          targetReads += 1;
          return post;
        },
      },
      { values: { post: "content.post.v1" } }
    );
    const comment = s.model({ id: s.string().id(), commentable });

    hydrateSchemaNames({ post, comment });

    expect(targetReads).toBe(0);
    expect(comment["~"].getPolymorphicRelationName("commentable")).toEqual({
      ts: "commentable",
      sql: "commentable",
    });
  });

  it("keeps a reused declaration independent of every owner", () => {
    const post = s.model({ id: s.string().id() });
    const target = s.polymorphicToOne(
      { post: () => post },
      { values: { post: "content.post.v1" } }
    );
    const first = s.model({ id: s.string().id(), target });
    const second = s.model({ id: s.string().id(), subject: target });

    hydrateSchemaNames({ post, first });
    hydrateSchemaNames({ post, second });

    expect(first["~"].getPolymorphicRelationName("target").ts).toBe("target");
    expect(second["~"].getPolymorphicRelationName("subject").ts).toBe(
      "subject"
    );
    expect(target["~"].state).not.toHaveProperty("source");
  });

  it("keeps carrier instances immutable", () => {
    const post = s.model({ id: s.string().id() });
    const base = s.polymorphicToOne(
      { post: () => post },
      { values: { post: "content.post.v1" } }
    );
    const named = base.name("target");
    const optional = named.optional();

    expect("name" in base["~"].state).toBe(false);
    expect("optional" in named["~"].state).toBe(false);
    expect(optional["~"].state).toMatchObject({
      name: "target",
      optional: true,
    });
  });

  // The reuse question the deleted builder used to answer, asked of the two
  // factories instead: ONE plain target map, handed to both, must produce two
  // independent carriers and must still invoke no target getter.
  it("builds independent carriers from one reused target map", () => {
    let targetReads = 0;
    const post = s.model({ id: s.string().id() });
    const targets = {
      post: () => {
        targetReads += 1;
        return post;
      },
    };
    const values = { post: "content.post.v1" } as const;
    const singular = s.polymorphicToOne(targets, { values });
    const collection = s.polymorphicToMany(targets, { values });

    expect(singular).not.toBe(collection);
    expect(singular["~"].state.cardinality).toBe("one");
    expect(collection["~"].state.cardinality).toBe("many");
    expect(singular["~"].state.targets).not.toBe(collection["~"].state.targets);
    expect(targetReads).toBe(0);

    const named = singular.name("target").optional();

    expect(named["~"].state).toMatchObject({
      cardinality: "one",
      name: "target",
      optional: true,
    });
    expect(singular["~"].state).not.toHaveProperty("name");
    expect(collection.name("attachments")["~"].state.cardinality).toBe("many");
    expect(targetReads).toBe(0);
  });

  it("snapshots and freezes non-fresh maps before resolving targets once", () => {
    let targetReads = 0;
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const targets = {
      post: () => {
        targetReads += 1;
        return post;
      },
      video: () => {
        targetReads += 1;
        return video;
      },
    };
    const values = {
      post: "content.post.v1",
      video: "content.video.v1",
    };
    const relation = s.polymorphicToOne(targets, { values });

    targets.post = () => video;
    values.post = "mutated";

    const first = relation["~"].targetEntries();
    const second = relation["~"].targetEntries();

    expect(first).toBe(second);
    expect(targetReads).toBe(2);
    expect(Object.isFrozen(relation["~"].state.targets)).toBe(true);
    expect(Object.isFrozen(relation["~"].state.values)).toBe(true);
    expect(first).toEqual([
      {
        publicType: "post",
        targetGetter: expect.any(Function),
        targetModel: post,
        storedType: "content.post.v1",
      },
      {
        publicType: "video",
        targetGetter: expect.any(Function),
        targetModel: video,
        storedType: "content.video.v1",
      },
    ]);
  });

  it("keeps runtime inverse selection aligned with relation-group semantics", () => {
    const source = s.model({ id: s.string().id() });
    const sole = s.model({
      id: s.string().id(),
      subject: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.sole.v1" } }
        )
        .name("declared"),
    });
    const multiple = s.model({
      id: s.string().id(),
      first: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.first.v1" } }
        )
        .name("shared"),
      second: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.second.v1" } }
        )
        .name("shared"),
    });
    const selectedWithUnselectedDuplicate = s.model({
      id: s.string().id(),
      selected: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.selected.v1" } }
        )
        .name("selected"),
      duplicate: s
        .polymorphicToOne(
          { first: () => source, second: () => source },
          {
            values: {
              first: "source.duplicate-first.v1",
              second: "source.duplicate-second.v1",
            },
          }
        )
        .name("other"),
    });
    const identicalPost = s.model({ id: s.string().id() });
    const identicalVideo = s.model({ id: s.string().id() });
    const identicalTargets = s.model({
      id: s.string().id(),
      subject: s.polymorphicToOne(
        { post: () => identicalPost, video: () => identicalVideo },
        { values: { post: "post.v1", video: "video.v1" } }
      ),
    });
    const unnamedAndNamed = s.model({
      id: s.string().id(),
      unnamed: s.polymorphicToOne(
        { source: () => source },
        { values: { source: "source.unnamed.v1" } }
      ),
      named: s
        .polymorphicToOne(
          { source: () => source },
          { values: { source: "source.named.v1" } }
        )
        .name("named"),
    });
    const separateIdenticalPost = s.model({ id: s.string().id() });
    const separateIdenticalVideo = s.model({ id: s.string().id() });
    const separatelyGroupedIdenticalTargets = s.model({
      id: s.string().id(),
      subject: s
        .polymorphicToOne(
          { post: () => separateIdenticalPost },
          { values: { post: "post.v1" } }
        )
        .name("subject"),
      attachment: s
        .polymorphicToOne(
          { video: () => separateIdenticalVideo },
          { values: { video: "video.v1" } }
        )
        .name("attachment"),
    });

    expect(getPolymorphicInverseBinding(sole, source, "mismatch")).toEqual({
      relationKey: "subject",
      publicType: "source",
      storedType: "source.sole.v1",
    });
    expect(
      getPolymorphicInverseBinding(multiple, source, undefined)
    ).toBeUndefined();
    expect(
      getPolymorphicInverseBinding(multiple, source, "missing")
    ).toBeUndefined();
    expect(
      getPolymorphicInverseBinding(multiple, source, "shared")
    ).toBeUndefined();
    expect(
      getPolymorphicInverseBinding(
        selectedWithUnselectedDuplicate,
        source,
        "selected"
      )
    ).toEqual({
      relationKey: "selected",
      publicType: "source",
      storedType: "source.selected.v1",
    });
    expect(
      getPolymorphicInverseBinding(
        selectedWithUnselectedDuplicate,
        source,
        "other"
      )
    ).toBeUndefined();
    expect(
      getPolymorphicInverseBinding(identicalTargets, identicalPost, undefined)
    ).toEqual({
      relationKey: "subject",
      publicType: "post",
      storedType: "post.v1",
    });
    expect(
      getPolymorphicInverseBinding(unnamedAndNamed, source, undefined)
    ).toBeUndefined();
    expect(
      getPolymorphicInverseBinding(
        separatelyGroupedIdenticalTargets,
        separateIdenticalPost,
        undefined
      )
    ).toBeUndefined();
    expect(
      getPolymorphicInverseBinding(
        separatelyGroupedIdenticalTargets,
        separateIdenticalPost,
        "subject"
      )
    ).toEqual({
      relationKey: "subject",
      publicType: "post",
      storedType: "post.v1",
    });
  });

  it("does not replace an ordinary inverse with a coexisting polymorphic edge", () => {
    const parent = s.model({ id: s.string().id() });
    const other = s.model({ id: s.string().id() });
    const child = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .manyToOne(() => parent)
        .fields("parentId")
        .references("id"),
      subject: s
        .polymorphicToOne(
          { parent: () => parent, other: () => other },
          { values: { parent: "parent.v1", other: "other.v1" } }
        )
        .name("subject"),
    });

    expect(
      getPolymorphicInverseBinding(child, parent, undefined)
    ).toBeUndefined();
    expect(getPolymorphicInverseBinding(child, parent, "subject")).toEqual({
      relationKey: "subject",
      publicType: "parent",
      storedType: "parent.v1",
    });
  });

  it("carries a deep-frozen .through() map in either chain order", () => {
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const targets = { post: () => post, video: () => video };
    const throughFirst = s
      .polymorphicToMany(targets)
      .through(THROUGH_MAP)
      .name("items");
    const nameFirst = s
      .polymorphicToMany(targets)
      .name("items")
      .through(THROUGH_MAP);

    for (const relation of [throughFirst, nameFirst]) {
      expect(relation["~"].state.name).toBe("items");
      expect(relation["~"].state.through).toEqual(THROUGH_MAP);
      expect(Object.isFrozen(relation["~"].state.through)).toBe(true);
      expect(Object.isFrozen(relation["~"].state.through?.post)).toBe(true);
    }
  });

  // The `.through()` snapshot is ONE LEVEL DEEPER than the targets/values
  // snapshot: the map's own properties are entry OBJECTS, so a live accessor on
  // an ENTRY is the dodge to close — a `table` answering the definition
  // validator with one name and a later storage reader with another. Every own
  // property on both levels is read exactly once, at construction.
  it("pins accessor-supplied through entries at construction", () => {
    const post = s.model({ id: s.string().id() });
    let tableReads = 0;
    const entry = {
      get table(): string {
        tableReads += 1;
        return tableReads === 1 ? "owner_items_post" : "### hostile flip ###";
      },
      source: "ownerRef",
      target: "postRef",
    };
    const relation = s
      .polymorphicToMany({ post: () => post })
      .through({ post: entry });

    expect(tableReads).toBe(1);
    expect(relation["~"].state.through?.post.table).toBe("owner_items_post");
    expect(relation["~"].state.through?.post.table).toBe("owner_items_post");
    expect(tableReads).toBe(1);
  });
});

describe("coverage low value", () => {
  it("fails closed for malformed relation carriers", () => {
    const source = s.model({ id: s.string().id() });
    const malformedTargets = Reflect.construct(PolymorphicToOneRelation, [
      {
        type: "polymorphic",
        cardinality: "one",
        targets: {
          [Symbol("ignored")]: () => source,
          badGetter: 42,
          badValue: () => source,
        },
        values: {
          badGetter: "bad-getter",
          badValue: 42,
        },
      },
    ]);
    const target = s.model({ id: s.string().id(), subject: malformedTargets });
    const malformedState = Reflect.construct(PolymorphicToOneRelation, [
      { type: "polymorphic", cardinality: "one", targets: null, values: null },
    ]);
    const missingValues = Reflect.construct(PolymorphicToOneRelation, [
      {
        type: "polymorphic",
        cardinality: "one",
        targets: { source: () => source },
        values: 42,
      },
    ]);

    expect(getPolymorphicInverseCandidates(target, source)).toEqual([]);
    expect(malformedState["~"].targetEntries()).toEqual([]);
    expect(missingValues["~"].targetEntries()).toEqual([
      {
        publicType: "source",
        targetGetter: expect.any(Function),
        targetModel: source,
        storedType: undefined,
      },
    ]);
  });

  it("enumerates every carrier a target holds, terminated or not", () => {
    // Executes the `targetEntries` closure on a FORGED cardinality-less carrier
    // and on the to-many terminal. Only definition validation reaches them in
    // anger, and the behavioural contract they serve there — one owned P013
    // issue instead of a TypeError — is pinned in
    // `tests/unit/schema-validation/polymorphic-rules.core.test.ts`.
    const source = s.model({ id: s.string().id() });
    const ForgedCarrier: new (...args: never) => unknown =
      PolymorphicToOneRelation;
    const target = s.model({
      id: s.string().id(),
      unfinished: Reflect.construct(ForgedCarrier, [
        {
          type: "polymorphic",
          targets: { source: () => source },
          values: { source: "source.unfinished.v1" },
        },
      ]),
      collection: s.polymorphicToMany(
        { source: () => source },
        { values: { source: "source.collection.v1" } }
      ),
    });

    expect(getPolymorphicInverseCandidates(target, source)).toEqual([
      {
        relationKey: "unfinished",
        publicType: "source",
        storedType: "source.unfinished.v1",
        pairingName: undefined,
      },
      {
        relationKey: "collection",
        publicType: "source",
        storedType: "source.collection.v1",
        pairingName: undefined,
      },
    ]);
  });

  it("recognizes only a complete polymorphic carrier", () => {
    const relation = s.polymorphicToOne({
      post: () => s.model({ id: s.string().id() }),
    });

    expect(isPolymorphicRelation(relation)).toBe(true);
    expect(isPolymorphicRelation(42)).toBe(false);
    expect(isPolymorphicRelation(() => undefined)).toBe(false);
    expect(isPolymorphicRelation({ "~": null })).toBe(false);
    expect(isPolymorphicRelation({ "~": { state: null } })).toBe(false);
    expect(
      isPolymorphicRelation({ "~": { state: { type: "ordinary" } } })
    ).toBe(false);
  });
});
