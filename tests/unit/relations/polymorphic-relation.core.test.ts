import {
  getPolymorphicInverseBinding,
  hydrateSchemaNames,
  s,
} from "@src/schema";
import {
  getPolymorphicInverseCandidates,
  isPolymorphicRelation,
  PolymorphicRelation,
} from "@src/schema/relation";
import { describe, expect, it } from "vitest";

describe("polymorphic relation carrier", () => {
  it("defaults stored discriminators to the public target keys", () => {
    let targetReads = 0;
    const post = s.model({ id: s.string().id() });
    const video = s.model({ id: s.string().id() });
    const relation = s.polymorphic({
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
      .polymorphic(
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
    const commentable = s.polymorphic(
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
    const target = s.polymorphic(
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

  it("keeps builder instances immutable", () => {
    const post = s.model({ id: s.string().id() });
    const base = s.polymorphic(
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
    const relation = s.polymorphic(targets, { values });

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
        .polymorphic(
          { source: () => source },
          { values: { source: "source.sole.v1" } }
        )
        .name("declared"),
    });
    const multiple = s.model({
      id: s.string().id(),
      first: s
        .polymorphic(
          { source: () => source },
          { values: { source: "source.first.v1" } }
        )
        .name("shared"),
      second: s
        .polymorphic(
          { source: () => source },
          { values: { source: "source.second.v1" } }
        )
        .name("shared"),
    });
    const selectedWithUnselectedDuplicate = s.model({
      id: s.string().id(),
      selected: s
        .polymorphic(
          { source: () => source },
          { values: { source: "source.selected.v1" } }
        )
        .name("selected"),
      duplicate: s
        .polymorphic(
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
      subject: s.polymorphic(
        { post: () => identicalPost, video: () => identicalVideo },
        { values: { post: "post.v1", video: "video.v1" } }
      ),
    });
    const unnamedAndNamed = s.model({
      id: s.string().id(),
      unnamed: s.polymorphic(
        { source: () => source },
        { values: { source: "source.unnamed.v1" } }
      ),
      named: s
        .polymorphic(
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
        .polymorphic(
          { post: () => separateIdenticalPost },
          { values: { post: "post.v1" } }
        )
        .name("subject"),
      attachment: s
        .polymorphic(
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
        .polymorphic(
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
});

describe("coverage low value", () => {
  it("fails closed for malformed relation carriers", () => {
    const source = s.model({ id: s.string().id() });
    const malformedTargets = Reflect.construct(PolymorphicRelation, [
      {
        type: "polymorphic",
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
    const malformedState = Reflect.construct(PolymorphicRelation, [
      { type: "polymorphic", targets: null, values: null },
    ]);
    const missingValues = Reflect.construct(PolymorphicRelation, [
      {
        type: "polymorphic",
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

  it("recognizes only a complete polymorphic carrier", () => {
    const relation = s.polymorphic({
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
