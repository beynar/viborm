import { hydrateSchemaNames, s } from "@schema";
import {
  findPairedManyToManyState,
  generateJunctionFieldName,
  generateJunctionTableName,
  getJunctionFieldNames,
  getJunctionTableName,
} from "@schema/relation/helpers";

describe("many-to-many junction helpers", () => {
  test("generates stable lower-case defaults and preserves non-M:N fallback", () => {
    const target = s.model({ id: s.string().id() });
    const inverse = s.oneToMany(() => target);
    const manyToMany = s.manyToMany(() => target);
    const source = s.model({ id: s.string().id(), targets: manyToMany });
    hydrateSchemaNames({ source, target });

    expect(generateJunctionTableName("Tag", "Post")).toBe("post_tag");
    expect(generateJunctionFieldName("User")).toBe("userId");
    expect(findPairedManyToManyState(inverse)).toBeUndefined();
    expect(getJunctionTableName(inverse, "Post", "Tag")).toBe("post_tag");
    expect(getJunctionTableName(manyToMany, "Source", "Target")).toBe(
      "source_target"
    );
    expect(getJunctionFieldNames(inverse, "Post", "Tag")).toEqual([
      "postId",
      "tagId",
    ]);
  });

  test("does not pair an unbound relation or a relation with a non-model target", () => {
    const target = s.model({ id: s.string().id() });
    const unbound = s.manyToMany(() => target);
    expect(findPairedManyToManyState(unbound)).toBeUndefined();

    const missingTarget = s.manyToMany(() => undefined);
    const source = s.model({
      id: s.string().id(),
      missingTarget,
    });
    hydrateSchemaNames({ source });

    expect(findPairedManyToManyState(missingTarget)).toBeUndefined();
  });

  test("ignores unrelated target relations while locating the pair", () => {
    const unrelated = s.model({ id: s.string().id() });
    const forward = s.manyToMany(() => target).name("pair");
    const source = s.model({ id: s.string().id(), targets: forward });
    const back = s.manyToMany(() => source).name("pair");
    const target = s.model({
      id: s.string().id(),
      sourceId: s.string(),
      owner: s
        .manyToOne(() => source)
        .fields("sourceId")
        .references("id"),
      unrelated: s.manyToMany(() => unrelated),
      sources: back,
    });
    hydrateSchemaNames({ source, target, unrelated });

    expect(findPairedManyToManyState(forward)).toBe(back["~"].state);
  });

  test("treats differently named sole candidates as different pairs", () => {
    const forward = s.manyToMany(() => target).name("visible");
    const source = s.model({ id: s.string().id(), targets: forward });
    const back = s.manyToMany(() => source).name("archived");
    const target = s.model({ id: s.string().id(), sources: back });
    hydrateSchemaNames({ source, target });

    expect(findPairedManyToManyState(forward)).toBeUndefined();
  });

  test("uses the relation name to select one of several candidates", () => {
    const featured = s.manyToMany(() => tag).name("featured");
    const post = s.model({ id: s.string().id(), tags: featured });
    const featuredPosts = s.manyToMany(() => post).name("featured");
    const archivedPosts = s.manyToMany(() => post).name("archived");
    const tag = s.model({
      id: s.string().id(),
      featuredPosts,
      archivedPosts,
    });
    hydrateSchemaNames({ post, tag });

    expect(findPairedManyToManyState(featured)).toBe(featuredPosts["~"].state);
  });

  test("rejects an ambiguous set of paired candidates", () => {
    const forward = s.manyToMany(() => target).name("missing");
    const source = s.model({ id: s.string().id(), targets: forward });
    const first = s.manyToMany(() => source).name("first");
    const second = s.manyToMany(() => source).name("second");
    const target = s.model({ id: s.string().id(), first, second });
    hydrateSchemaNames({ source, target });

    expect(() => findPairedManyToManyState(forward)).toThrowError(
      "Multiple many-to-many relation pairs between 'source' and 'target' are ambiguous — give each pair a distinct .name() on both sides."
    );
  });

  test("resolves an explicit table configured on either or both sides", () => {
    const forward = s.manyToMany(() => tag).through("post_tags");
    const post = s.model({ id: s.string().id(), tags: forward });
    const back = s.manyToMany(() => post).through("post_tags");
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    expect(getJunctionTableName(forward, "Post", "Tag")).toBe("post_tags");
    expect(getJunctionTableName(back, "Tag", "Post")).toBe("post_tags");

    const pairedOnly = s.manyToMany(() => category);
    const article = s.model({ id: s.string().id(), categories: pairedOnly });
    const categories = s
      .manyToMany(() => article)
      .through("article_categories");
    const category = s.model({ id: s.string().id(), articles: categories });
    hydrateSchemaNames({ article, category });

    expect(getJunctionTableName(pairedOnly, "Article", "Category")).toBe(
      "article_categories"
    );
  });

  test("derives a separate table for a named pair", () => {
    const forward = s.manyToMany(() => tag).name("featured");
    const post = s.model({ id: s.string().id(), tags: forward });
    const back = s.manyToMany(() => post).name("featured");
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    expect(getJunctionTableName(forward, "Post", "Tag")).toBe(
      "post_tag_featured"
    );

    const pairedNamedOnly = s.manyToMany(() => category);
    const article = s.model({
      id: s.string().id(),
      categories: pairedNamedOnly,
    });
    const articles = s.manyToMany(() => article).name("curated");
    const category = s.model({ id: s.string().id(), articles });
    hydrateSchemaNames({ article, category });

    expect(getJunctionTableName(pairedNamedOnly, "Article", "Category")).toBe(
      "article_category_curated"
    );
  });

  test("rejects conflicting explicit table names", () => {
    const forward = s.manyToMany(() => tag).through("post_tags");
    const post = s.model({ id: s.string().id(), tags: forward });
    const back = s.manyToMany(() => post).through("tag_posts");
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    expect(() => getJunctionTableName(forward, "Post", "Tag")).toThrowError(
      "Many-to-many relations between 'Post' and 'Tag' disagree on .through(): 'post_tags' vs 'tag_posts'."
    );
  });

  test("mirrors junction columns configured on the paired side", () => {
    const forward = s.manyToMany(() => tag);
    const post = s.model({ id: s.string().id(), tags: forward });
    const back = s
      .manyToMany(() => post)
      .A("tag_fk")
      .B("post_fk");
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    expect(getJunctionFieldNames(forward, "Post", "Tag")).toEqual([
      "post_fk",
      "tag_fk",
    ]);
  });

  test.each([
    ["A", "post_fk", "other_post_fk", "B"],
    ["B", "tag_fk", "other_tag_fk", "A"],
  ] as const)("rejects a conflicting %s column", (side, ownColumn, pairedColumn, pairedSide) => {
    const forward =
      side === "A"
        ? s.manyToMany(() => tag).A(ownColumn)
        : s.manyToMany(() => tag).B(ownColumn);
    const post = s.model({ id: s.string().id(), tags: forward });
    const back =
      pairedSide === "A"
        ? s.manyToMany(() => post).A(pairedColumn)
        : s.manyToMany(() => post).B(pairedColumn);
    const tag = s.model({ id: s.string().id(), posts: back });
    hydrateSchemaNames({ post, tag });

    expect(() => getJunctionFieldNames(forward, "Post", "Tag")).toThrow(
      "disagree on junction columns"
    );
  });

  test("uses one explicit column with a generated target column", () => {
    const forward = s.manyToMany(() => tag).A("post_fk");
    const post = s.model({ id: s.string().id(), tags: forward });
    const tag = s.model({ id: s.string().id() });
    hydrateSchemaNames({ post, tag });

    expect(getJunctionFieldNames(forward, "Post", "Tag")).toEqual([
      "post_fk",
      "tagId",
    ]);
  });

  test("generates distinct columns for a single self relation", () => {
    const peers = s.manyToMany(() => node);
    const node = s.model({ id: s.string().id(), peers });
    hydrateSchemaNames({ node });

    expect(findPairedManyToManyState(peers)).toBeUndefined();
    expect(getJunctionFieldNames(peers, "Node", "Node")).toEqual([
      "nodeAId",
      "nodeBId",
    ]);
  });

  test("rejects a paired self relation without explicit columns", () => {
    const parents = s.manyToMany(() => node).name("tree");
    const children = s.manyToMany(() => node).name("tree");
    const node = s.model({ id: s.string().id(), parents, children });
    hydrateSchemaNames({ node });

    expect(() => getJunctionFieldNames(parents, "Node", "Node")).toThrowError(
      "Self-referential many-to-many relations on 'Node' require explicit junction columns: set .A() and .B() on one side of the pair."
    );
  });

  test("accepts mirrored explicit columns for a paired self relation", () => {
    const parents = s
      .manyToMany(() => node)
      .name("tree")
      .A("parent_id")
      .B("child_id");
    const children = s
      .manyToMany(() => node)
      .name("tree")
      .A("child_id")
      .B("parent_id");
    const node = s.model({ id: s.string().id(), parents, children });
    hydrateSchemaNames({ node });

    expect(getJunctionFieldNames(parents, "Node", "Node")).toEqual([
      "parent_id",
      "child_id",
    ]);
  });
});

describe("many-to-many relation builder", () => {
  test("applies every modifier immutably and binds its source once hydrated", () => {
    const tag = s.model({ id: s.string().id() });
    const base = s.manyToMany(() => tag);
    const configured = base
      .through("post_tags")
      .A("post_id")
      .B("tag_id")
      .onDelete("cascade")
      .onUpdate("restrict")
      .name("tags");

    expect(base).not.toBe(configured);
    expect(base["~"].state).not.toHaveProperty("through");
    expect(configured["~"].state).toMatchObject({
      type: "manyToMany",
      through: "post_tags",
      A: "post_id",
      B: "tag_id",
      onDelete: "cascade",
      onUpdate: "restrict",
      name: "tags",
    });
    expect(configured["~"].state.getter()).toBe(tag);

    const post = s.model({ id: s.string().id(), tags: configured });
    hydrateSchemaNames({ post, tag });
    expect(configured["~"].state.source).toBe(post);
  });
});

describe("to-one and to-many relation builders", () => {
  test("applies modifiers immutably and binds both relation sources", () => {
    const target = s.model({ id: s.string().id() });
    const baseToOne = s.manyToOne(() => target);
    const configuredToOne = baseToOne
      .fields("targetId")
      .references("id")
      .optional()
      .onDelete("setNull")
      .onUpdate("cascade")
      .name("target");
    const baseToMany = s.oneToMany(() => target);
    const configuredToMany = baseToMany.name("targets");

    expect(baseToOne).not.toBe(configuredToOne);
    expect(baseToOne["~"].state).not.toHaveProperty("fields");
    expect(configuredToOne["~"].state).toMatchObject({
      type: "manyToOne",
      fields: ["targetId"],
      references: ["id"],
      optional: true,
      onDelete: "setNull",
      onUpdate: "cascade",
      name: "target",
    });
    expect(baseToMany).not.toBe(configuredToMany);
    expect(baseToMany["~"].state).not.toHaveProperty("name");
    expect(configuredToMany["~"].state).toMatchObject({
      type: "oneToMany",
      name: "targets",
    });

    const source = s.model({
      id: s.string().id(),
      targetId: s.string().nullable(),
      target: configuredToOne,
      targets: configuredToMany,
    });
    hydrateSchemaNames({ source, target });

    expect(configuredToOne["~"].state.source).toBe(source);
    expect(configuredToMany["~"].state.source).toBe(source);
  });
});

describe("coverage low value", () => {
  test("pins memoization of the internal relation accessor", () => {
    const target = s.model({ id: s.string().id() });
    const relation = s.manyToMany(() => target);

    expect(relation["~"]).toBe(relation["~"]);
  });
});
