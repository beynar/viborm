/**
 * Serializer Tests
 *
 * Tests for serializeModels() function, particularly junction table generation.
 */

import { describe, expect, it } from "vitest";
import { postgresMigrationDriver } from "../../src/migrations/drivers/postgres";
import { serializeModels } from "../../src/migrations/serializer";
import { s } from "../../src/schema";
import { hydrateSchemaNames } from "../../src/schema/hydration";

// =============================================================================
// JUNCTION TABLE TESTS
// =============================================================================

describe("junction table generation", () => {
  it("creates junction table for manyToMany relation", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    // Should have 3 tables: post, tag, and junction table
    expect(snapshot.tables).toHaveLength(3);

    const junctionTable = snapshot.tables.find((t) => t.name === "post_tag");
    expect(junctionTable).toBeDefined();
    expect(junctionTable!.columns).toHaveLength(2);
    expect(junctionTable!.columns[0]!.name).toBe("postId");
    expect(junctionTable!.columns[1]!.name).toBe("tagId");
    expect(junctionTable!.primaryKey).toEqual({
      columns: ["postId", "tagId"],
    });
  });

  it("uses custom through() table name", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => Tag).through("custom_junction"),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post).through("custom_junction"),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const junctionTable = snapshot.tables.find(
      (t) => t.name === "custom_junction"
    );
    expect(junctionTable).toBeDefined();
  });

  it("uses custom A()/B() field names", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s
        .manyToMany(() => Tag)
        .A("post_fk")
        .B("tag_fk"),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s
        .manyToMany(() => Post)
        .A("tag_fk")
        .B("post_fk"),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const junctionTable = snapshot.tables.find((t) => t.name === "post_tag");
    expect(junctionTable).toBeDefined();
    expect(junctionTable!.columns.map((c) => c.name).sort()).toEqual([
      "post_fk",
      "tag_fk",
    ]);
  });

  it("includes correct foreign keys", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const junctionTable = snapshot.tables.find((t) => t.name === "post_tag");
    expect(junctionTable).toBeDefined();
    expect(junctionTable!.foreignKeys).toHaveLength(2);

    const postFk = junctionTable!.foreignKeys.find((fk) =>
      fk.columns.includes("postId")
    );
    expect(postFk).toBeDefined();
    expect(postFk!.referencedTable).toBe("post");
    expect(postFk!.referencedColumns).toEqual(["id"]);

    const tagFk = junctionTable!.foreignKeys.find((fk) =>
      fk.columns.includes("tagId")
    );
    expect(tagFk).toBeDefined();
    expect(tagFk!.referencedTable).toBe("tag");
    expect(tagFk!.referencedColumns).toEqual(["id"]);
  });

  it("junction columns have correct types matching source PK", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => Tag),
    });

    const Tag = s.model({
      id: s.int().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const junctionTable = snapshot.tables.find((t) => t.name === "post_tag");
    expect(junctionTable).toBeDefined();

    const postIdCol = junctionTable!.columns.find((c) => c.name === "postId");
    const tagIdCol = junctionTable!.columns.find((c) => c.name === "tagId");

    // Post has string id -> text, Tag has int id -> integer
    expect(postIdCol!.type.toLowerCase()).toBe("text");
    expect(tagIdCol!.type.toLowerCase()).toBe("integer");
  });

  it("junction columns are not nullable", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const junctionTable = snapshot.tables.find((t) => t.name === "post_tag");
    expect(junctionTable).toBeDefined();

    for (const col of junctionTable!.columns) {
      expect(col.nullable).toBe(false);
    }
  });

  // Prisma parity: without explicit overrides, optional to-one relations
  // default to SET NULL on delete and required ones to RESTRICT, so deletes
  // behave identically across databases (MySQL checks self-referencing FKs
  // row-by-row where PG/SQLite validate at statement end).
  it("defaults onDelete to setNull for nullable FKs and restrict for required FKs", () => {
    const Category = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => Category)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => Category),
      items: s.oneToMany(() => Item),
    });

    const Item = s.model({
      id: s.string().id(),
      categoryId: s.string(),
      category: s
        .manyToOne(() => Category)
        .fields("categoryId")
        .references("id"),
    });

    const schema = { category: Category, item: Item };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const categoryFk = snapshot.tables.find((t) => t.name === "category")!
      .foreignKeys[0]!;
    expect(categoryFk.onDelete).toBe("setNull");
    expect(categoryFk.onUpdate).toBe("noAction");

    const itemFk = snapshot.tables.find((t) => t.name === "item")!
      .foreignKeys[0]!;
    expect(itemFk.onDelete).toBe("restrict");
    expect(itemFk.onUpdate).toBe("noAction");
  });

  it("keeps explicit referential action overrides", () => {
    const Parent = s.model({
      id: s.string().id(),
      children: s.oneToMany(() => Child),
    });

    const Child = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => Parent)
        .fields("parentId")
        .references("id")
        .optional()
        .onDelete("cascade")
        .onUpdate("restrict"),
    });

    const schema = { parent: Parent, child: Child };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const childFk = snapshot.tables.find((t) => t.name === "child")!
      .foreignKeys[0]!;
    expect(childFk.onDelete).toBe("cascade");
    expect(childFk.onUpdate).toBe("restrict");
  });

  // Prisma parity: implicit junction FKs cascade so deleting an endpoint
  // row removes its associations instead of throwing ForeignKeyError.
  it("foreign keys default to cascade", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const junctionTable = snapshot.tables.find((t) => t.name === "post_tag");
    expect(junctionTable).toBeDefined();

    for (const fk of junctionTable!.foreignKeys) {
      expect(fk.onDelete).toBe("cascade");
      expect(fk.onUpdate).toBe("cascade");
    }
  });

  it("throws on compound primary key with helpful suggestion", () => {
    const Post = s
      .model({
        title: s.string(),
        version: s.int(),
        tags: s.manyToMany(() => Tag),
      })
      .id(["title", "version"]);

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    expect(() =>
      serializeModels(schema, {
        migrationDriver: postgresMigrationDriver,
      })
    ).toThrow(/compound primary key.*surrogate key/i);
  });

  it("throws on missing primary key", () => {
    const Post = s.model({
      title: s.string(),
      tags: s.manyToMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    expect(() =>
      serializeModels(schema, {
        migrationDriver: postgresMigrationDriver,
      })
    ).toThrow(/no primary key field/i);
  });

  it("avoids duplicate junction table when both sides define relation", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.manyToMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.manyToMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    // Should only create one junction table, not two
    const junctionTables = snapshot.tables.filter((t) => t.name === "post_tag");
    expect(junctionTables).toHaveLength(1);
  });
});

// =============================================================================
// ENUM SERIALIZATION TESTS
// =============================================================================

describe("enum serialization", () => {
  it("accesses enum values correctly via enumValues getter", () => {
    const Status = s.model({
      id: s.string().id(),
      status: s.enum(["active", "inactive", "pending"]),
    });

    const schema = { status: Status };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    // Verify enum is created (PostgreSQL supports native enums)
    expect(snapshot.enums).toBeDefined();
    expect(snapshot.enums).toHaveLength(1);
    expect(snapshot.enums![0]!.values).toEqual([
      "active",
      "inactive",
      "pending",
    ]);
  });
});

// =============================================================================
// ONE-TO-ONE UNIQUE CONSTRAINT TESTS
// =============================================================================

describe("one-to-one FK unique constraint", () => {
  it("emits a unique constraint on the owning 1:1 FK column", () => {
    const User = s.model({
      id: s.string().id(),
      profile: s.oneToOne(() => Profile),
    });

    const Profile = s.model({
      id: s.string().id(),
      userId: s.string(),
      user: s
        .oneToOne(() => User)
        .fields("userId")
        .references("id"),
    });

    const schema = { user: User, profile: Profile };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const profileTable = snapshot.tables.find((t) => t.name === "profile");
    expect(profileTable!.uniqueConstraints).toEqual([
      { name: "profile_userId_key", columns: ["userId"] },
    ]);
  });

  it("does not duplicate the constraint when the FK is already .unique()", () => {
    const User = s.model({
      id: s.string().id(),
      profile: s.oneToOne(() => Profile),
    });

    const Profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .oneToOne(() => User)
        .fields("userId")
        .references("id"),
    });

    const schema = { user: User, profile: Profile };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const profileTable = snapshot.tables.find((t) => t.name === "profile");
    const userIdUniques = profileTable!.uniqueConstraints!.filter(
      (u) => u.columns.length === 1 && u.columns[0] === "userId"
    );
    expect(userIdUniques).toHaveLength(1);
  });

  it("does not add unique constraints for manyToOne FKs", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .manyToOne(() => User)
        .fields("authorId")
        .references("id"),
    });

    const schema = { user: User, post: Post };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const postTable = snapshot.tables.find((t) => t.name === "post");
    expect(postTable!.uniqueConstraints ?? []).toEqual([]);
  });
});

// =============================================================================
// DECLARED INDEX COLUMN RESOLUTION (Phase 2, Unit 2.1)
// =============================================================================

/**
 * `.index()` names TypeScript fields; the DDL has to name columns. A `.map()`ed
 * field made the two differ, and the index collection pushed the field name
 * straight through — so CREATE INDEX named a column that does not exist and the
 * push failed.
 */
describe("declared index columns resolve through .map()", () => {
  function serialize(schema: Record<string, any>) {
    hydrateSchemaNames(schema);
    return serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
  }

  it("writes the mapped column name into a single-field index", () => {
    const Post = s
      .model({
        id: s.string().id(),
        publishedAt: s.dateTime().map("published_at"),
      })
      .index(["publishedAt"]);

    const snapshot = serialize({ post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      expect.objectContaining({ columns: ["published_at"] }),
    ]);
  });

  it("writes the mapped column names into a compound index, in order", () => {
    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string().map("author_id"),
        publishedAt: s.dateTime().map("published_at"),
      })
      .index(["authorId", "publishedAt"]);

    const snapshot = serialize({ post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      expect.objectContaining({ columns: ["author_id", "published_at"] }),
    ]);
  });

  it("leaves an unmapped field's column name alone", () => {
    const Post = s
      .model({
        id: s.string().id(),
        publishedAt: s.dateTime(),
      })
      .index(["publishedAt"]);

    const snapshot = serialize({ post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      expect.objectContaining({ columns: ["publishedAt"] }),
    ]);
  });

  it("carries the mapped column name into a unique declared index too", () => {
    const Post = s
      .model({
        id: s.string().id(),
        slug: s.string().map("url_slug"),
      })
      .index(["slug"], { unique: true, name: "post_slug_uq" });

    const snapshot = serialize({ post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      {
        name: "post_slug_uq",
        columns: ["url_slug"],
        unique: true,
        type: undefined,
        where: undefined,
      },
    ]);
  });
});

// =============================================================================
// FOREIGN-KEY INDEX TESTS
// =============================================================================

/**
 * A manyToOne FK is read from the many side on every include, relation filter
 * and nested-write locate. Only MySQL/InnoDB indexes an FK constraint by
 * itself, so the serializer emits the index for every dialect — unless an index
 * the schema already declares covers the columns as a prefix.
 */
describe("foreign-key index for to-many relations", () => {
  function serialize(schema: Record<string, any>) {
    hydrateSchemaNames(schema);
    return serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
  }

  it("emits an index on the manyToOne FK column", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .manyToOne(() => User)
        .fields("authorId")
        .references("id"),
    });

    const snapshot = serialize({ user: User, post: Post });

    const postTable = snapshot.tables.find((t) => t.name === "post");
    expect(postTable!.indexes).toEqual([
      { name: "post_authorId_idx", columns: ["authorId"], unique: false },
    ]);
    // The user table holds no FK, so it gains no index.
    expect(snapshot.tables.find((t) => t.name === "user")!.indexes).toEqual([]);
  });

  it("names the mapped column, not the TypeScript field", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s.model({
      id: s.string().id(),
      authorId: s.string().map("author_id"),
      author: s
        .manyToOne(() => User)
        .fields("authorId")
        .references("id"),
    });

    const snapshot = serialize({ user: User, post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      { name: "post_author_id_idx", columns: ["author_id"], unique: false },
    ]);
  });

  it("emits ONE composite index over a compound FK, in FK order", () => {
    const Org = s
      .model({
        tenantId: s.string(),
        code: s.string(),
        members: s.oneToMany(() => Member),
      })
      .id(["tenantId", "code"]);

    const Member = s.model({
      id: s.string().id(),
      orgTenantId: s.string(),
      orgCode: s.string(),
      org: s
        .manyToOne(() => Org)
        .fields("orgTenantId", "orgCode")
        .references("tenantId", "code"),
    });

    const snapshot = serialize({ org: Org, member: Member });

    expect(snapshot.tables.find((t) => t.name === "member")!.indexes).toEqual([
      {
        name: "member_orgTenantId_orgCode_idx",
        columns: ["orgTenantId", "orgCode"],
        unique: false,
      },
    ]);
  });

  it("does not duplicate a user-declared index on the FK column", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .manyToOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .index(["authorId"]);

    const snapshot = serialize({ user: User, post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      {
        name: "post_authorId_idx",
        columns: ["authorId"],
        unique: undefined,
        type: undefined,
        where: undefined,
      },
    ]);
  });

  it("compares the declared index by its mapped column name", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string().map("author_id"),
        author: s
          .manyToOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .index(["authorId"]);

    const snapshot = serialize({ user: User, post: Post });

    // One index over the column, not two: the FK index must not be fooled into
    // emitting a second index over the same column. The declared entry now
    // carries the mapped column name too (the index collection resolves it),
    // so both readers compare the one name the database knows.
    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      {
        name: "post_authorId_idx",
        columns: ["author_id"],
        unique: undefined,
        type: undefined,
        where: undefined,
      },
    ]);
  });

  it("skips the index when the FK columns prefix a declared compound index", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        createdAt: s.string(),
        author: s
          .manyToOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .index(["authorId", "createdAt"]);

    const snapshot = serialize({ user: User, post: Post });

    expect(
      snapshot.tables.find((t) => t.name === "post")!.indexes.map((i) => i.name)
    ).toEqual(["post_authorId_createdAt_idx"]);
  });

  it("emits the index when the FK columns only SUFFIX a declared index", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        createdAt: s.string(),
        author: s
          .manyToOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .index(["createdAt", "authorId"]);

    const snapshot = serialize({ user: User, post: Post });

    // A B-tree on (createdAt, authorId) cannot serve a lookup on authorId
    // alone, so the FK still needs its own index.
    expect(
      snapshot.tables.find((t) => t.name === "post")!.indexes.map((i) => i.name)
    ).toEqual(["post_createdAt_authorId_idx", "post_authorId_idx"]);
  });

  it("skips the index when the FK column is unique", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s.model({
      id: s.string().id(),
      authorId: s.string().unique(),
      author: s
        .manyToOne(() => User)
        .fields("authorId")
        .references("id"),
    });

    const snapshot = serialize({ user: User, post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([]);
  });

  it("skips the index when the FK columns prefix the primary key", () => {
    const Post = s.model({
      id: s.string().id(),
      tags: s.oneToMany(() => PostTag),
    });

    const Tag = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => PostTag),
    });

    // An explicit junction model: its PK already indexes (postId, tagId), so
    // the FK to post is covered and only the FK to tag needs an index.
    const PostTag = s
      .model({
        postId: s.string(),
        tagId: s.string(),
        post: s
          .manyToOne(() => Post)
          .fields("postId")
          .references("id"),
        tag: s
          .manyToOne(() => Tag)
          .fields("tagId")
          .references("id"),
      })
      .id(["postId", "tagId"]);

    const snapshot = serialize({ post: Post, tag: Tag, postTag: PostTag });

    expect(
      snapshot.tables
        .find((t) => t.name === "postTag")!
        .indexes.map((i) => i.name)
    ).toEqual(["postTag_tagId_idx"]);
  });

  // REGRESSION (Phase 2 review): every declared index counted as coverage,
  // including one carrying a predicate. A partial index holds only the rows its
  // predicate keeps, so it cannot answer a lookup for an excluded row — and
  // declaring one silently removed the foreign-key index altogether, on the
  // exact column this plan calls its highest value. Harmless until Phase 2
  // taught SQLite to emit the WHERE; a live defect from that commit on.
  it("does not let a partial declared index cover the FK columns", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        published: s.boolean(),
        author: s
          .manyToOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .index(["authorId"], { where: "published = true" });

    const snapshot = serialize({ user: User, post: Post });

    // Two indexes over one column, and only one of them is the whole column.
    // The automatic index cannot take the name the declared one holds, so it
    // takes the name of the constraint it serves.
    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      {
        name: "post_authorId_idx",
        columns: ["authorId"],
        unique: undefined,
        type: undefined,
        where: "published = true",
      },
      {
        name: "post_authorId_fkey_idx",
        columns: ["authorId"],
        unique: false,
      },
    ]);
  });

  // The fallback name is keyed on the name being taken, not on the predicate:
  // a mapped field spells the declared index after the field and the automatic
  // index after the column, so nothing collides and the preferred name stands.
  it("keeps the preferred name when the partial index does not hold it", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string().map("author_id"),
        published: s.boolean(),
        author: s
          .manyToOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .index(["authorId"], { where: "published = true" });

    const snapshot = serialize({ user: User, post: Post });

    expect(
      snapshot.tables.find((t) => t.name === "post")!.indexes.map((i) => i.name)
    ).toEqual(["post_authorId_idx", "post_author_id_idx"]);
  });

  it("adds no FK index for a oneToOne relation", () => {
    const User = s.model({
      id: s.string().id(),
      profile: s.oneToOne(() => Profile),
    });

    const Profile = s.model({
      id: s.string().id(),
      userId: s.string(),
      user: s
        .oneToOne(() => User)
        .fields("userId")
        .references("id"),
    });

    const snapshot = serialize({ user: User, profile: Profile });

    const profileTable = snapshot.tables.find((t) => t.name === "profile");
    // The unique constraint the 1:1 case emits is the index.
    expect(profileTable!.indexes).toEqual([]);
    expect(profileTable!.uniqueConstraints).toEqual([
      { name: "profile_userId_key", columns: ["userId"] },
    ]);
  });

  // The accepted case, pinned so the branch below cannot be read as dead: a
  // declared UNIQUE index over the whole column IS the 1:1 uniqueness.
  it("accepts a total declared UNIQUE index as the 1:1 uniqueness", () => {
    const User = s.model({
      id: s.string().id(),
      profile: s.oneToOne(() => Profile),
    });

    const Profile = s
      .model({
        id: s.string().id(),
        userId: s.string(),
        user: s
          .oneToOne(() => User)
          .fields("userId")
          .references("id"),
      })
      .index(["userId"], { unique: true });

    const snapshot = serialize({ user: User, profile: Profile });

    expect(
      snapshot.tables.find((t) => t.name === "profile")!.uniqueConstraints
    ).toEqual([]);
  });

  // REGRESSION (Phase 2 review): the same predicate blindness degraded a 1:1
  // relation to N:1. A partial UNIQUE index constrains only the rows its
  // predicate keeps, so two rows excluded by it can hold the same FK — two
  // profiles owning one user, which is what the branch exists to forbid.
  it("does not accept a partial UNIQUE index as the 1:1 uniqueness", () => {
    const User = s.model({
      id: s.string().id(),
      profile: s.oneToOne(() => Profile),
    });

    const Profile = s
      .model({
        id: s.string().id(),
        userId: s.string(),
        active: s.boolean(),
        user: s
          .oneToOne(() => User)
          .fields("userId")
          .references("id"),
      })
      .index(["userId"], { unique: true, where: "active = true" });

    const snapshot = serialize({ user: User, profile: Profile });

    expect(
      snapshot.tables.find((t) => t.name === "profile")!.uniqueConstraints
    ).toEqual([{ name: "profile_userId_key", columns: ["userId"] }]);
  });
});

// =============================================================================
// COMPOUND KEY SERIALIZATION TESTS
// =============================================================================

describe("compound key serialization", () => {
  it("emits the compound primary key columns", () => {
    const Membership = s
      .model({
        orgId: s.string(),
        memberId: s.string(),
      })
      .id(["orgId", "memberId"]);

    const schema = { membership: Membership };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const table = snapshot.tables.find((t) => t.name === "membership");
    expect(table!.primaryKey).toEqual({
      columns: ["orgId", "memberId"],
      name: "membership_pkey",
    });
  });

  it("emits all accumulated compound unique constraints", () => {
    const Membership = s
      .model({
        orgId: s.string(),
        memberId: s.string(),
        email: s.string(),
        tenantId: s.string(),
      })
      .id(["orgId", "memberId"])
      .unique(["email", "tenantId"])
      .unique(["orgId", "email"]);

    const schema = { membership: Membership };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const table = snapshot.tables.find((t) => t.name === "membership");
    expect(table!.uniqueConstraints).toHaveLength(2);
    expect(table!.uniqueConstraints!.map((u) => u.columns)).toEqual([
      ["email", "tenantId"],
      ["orgId", "email"],
    ]);
  });

  it("resolves compound key fields to their mapped column names", () => {
    const Membership = s
      .model({
        orgId: s.string().map("org_id"),
        memberId: s.string().map("member_id"),
        email: s.string().map("email_address"),
      })
      .id(["orgId", "memberId"])
      .unique(["orgId", "email"]);

    const schema = { membership: Membership };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    const table = snapshot.tables.find((t) => t.name === "membership");
    expect(table!.primaryKey!.columns).toEqual(["org_id", "member_id"]);
    expect(table!.uniqueConstraints!.map((u) => u.columns)).toEqual([
      ["org_id", "email_address"],
    ]);
  });
});
