/**
 * Serializer Tests
 *
 * Tests for serializeModels() function, particularly junction table generation.
 */

import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { serializeModels } from "@src/migrations/serializer";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { describe, expect, it } from "vitest";

// =============================================================================
// JUNCTION TABLE TESTS
// =============================================================================

describe("junction table generation", () => {
  it("creates junction table for manyToMany relation", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.toMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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
      // ONE endpoint owns every junction override (§4.4, R011).
      tags: s.toMany(() => Tag).through("custom_junction"),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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

  it("uses custom source()/target() field names", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s
        .toMany(() => Tag)
        .source("post_fk")
        .target("tag_fk"),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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

  it("serializes both compound junction sides from positional prefixes", () => {
    const Post = s
      .model({
        tenant: s.string().map("post_tenant"),
        slug: s.string().map("post_slug"),
        tags: s
          .toMany(() => Tag)
          .source("post")
          .target("tag"),
      })
      .id(["tenant", "slug"]);
    const Tag = s
      .model({
        locale: s.string().map("tag_locale"),
        code: s.int().map("tag_code"),
        posts: s.toMany(() => Post),
      })
      .id(["locale", "code"]);
    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    const junction = snapshot.tables.find((table) => table.name === "post_tag");

    expect(junction?.columns).toEqual([
      { name: "post_1", type: "text", nullable: false },
      { name: "post_2", type: "text", nullable: false },
      { name: "tag_1", type: "text", nullable: false },
      { name: "tag_2", type: "integer", nullable: false },
    ]);
    expect(junction?.primaryKey).toEqual({
      columns: ["post_1", "post_2", "tag_1", "tag_2"],
    });
    expect(junction?.indexes).toEqual([
      {
        name: "post_tag_tag_idx",
        columns: ["tag_1", "tag_2"],
        unique: false,
      },
    ]);
    expect(junction?.foreignKeys).toEqual([
      {
        name: "post_tag_post_fkey",
        columns: ["post_1", "post_2"],
        referencedTable: "post",
        referencedColumns: ["post_tenant", "post_slug"],
        onDelete: "cascade",
        onUpdate: "cascade",
      },
      {
        name: "post_tag_tag_fkey",
        columns: ["tag_1", "tag_2"],
        referencedTable: "tag",
        referencedColumns: ["tag_locale", "tag_code"],
        onDelete: "cascade",
        onUpdate: "cascade",
      },
    ]);
  });

  it("includes correct foreign keys", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.toMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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
      tags: s.toMany(() => Tag),
    });

    const Tag = s.model({
      id: s.int().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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
      tags: s.toMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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
        .toOne(() => Category)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => Category),
      items: s.toMany(() => Item),
    });

    const Item = s.model({
      id: s.string().id(),
      categoryId: s.string(),
      category: s
        .toOne(() => Category)
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
      children: s.toMany(() => Child),
    });

    const Child = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => Parent)
        .fields("parentId")
        .references("id")
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
      tags: s.toMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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

  it("uses a generated prefix for one compound junction side", () => {
    const Post = s
      .model({
        title: s.string(),
        version: s.int(),
        tags: s.toMany(() => Tag),
      })
      .id(["title", "version"]);

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    const junction = snapshot.tables.find((table) => table.name === "post_tag");

    expect(junction?.columns.map((column) => column.name)).toEqual([
      "post_1",
      "post_2",
      "tagId",
    ]);
    expect(junction?.primaryKey?.columns).toEqual([
      "post_1",
      "post_2",
      "tagId",
    ]);
  });

  // The row-key refusal is the GATE's now, and this is the witness that the
  // serializer cannot get past it: `serializeModels` resolves the schema when no
  // index is handed to it, so a junction endpoint with no row key stops the call
  // before one column of DDL exists.
  it("refuses a junction endpoint with no primary key, at the gate", () => {
    const Post = s.model({
      title: s.string(),
      tags: s.toMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
    });

    const schema = { post: Post, tag: Tag };
    hydrateSchemaNames(schema);

    expect(() =>
      serializeModels(schema, {
        migrationDriver: postgresMigrationDriver,
      })
    ).toThrow("[JT002]");
  });

  it("avoids duplicate junction table when both sides define relation", () => {
    const Post = s.model({
      id: s.string().id(),
      title: s.string(),
      tags: s.toMany(() => Tag),
    });

    const Tag = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => Post),
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
  it("keeps the R008 optional correction out of physical snapshots", () => {
    function snapshot(optional: boolean) {
      const User = s.model({
        id: s.string().id(),
        profile: optional ? s.toOne(() => Profile) : s.toOne(() => Profile),
      });
      const Profile = s.model({
        id: s.string().id(),
        userId: s.string().unique(),
        user: s
          .toOne(() => User)
          .fields("userId")
          .references("id"),
      });
      const schema = { user: User, profile: Profile };
      hydrateSchemaNames(schema);
      return serializeModels(schema, {
        migrationDriver: postgresMigrationDriver,
      });
    }

    expect(snapshot(true)).toEqual(snapshot(false));
  });

  it("emits a unique constraint on the owning 1:1 FK column", () => {
    const User = s.model({
      id: s.string().id(),
      profile: s.toOne(() => Profile),
    });

    const Profile = s.model({
      id: s.string().id(),
      userId: s.string(),
      user: s
        .toOne(() => User)
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
      profile: s.toOne(() => Profile),
    });

    const Profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .toOne(() => User)
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
      posts: s.toMany(() => Post),
    });

    const Post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => User)
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

  /**
   * Plan §10.6. Everything under the schema already spoke `fulltext` — the
   * MySQL emitter, its introspection, its capability list and the snapshot's
   * own `IndexDef` — but `IndexType` could not spell it, so no schema could
   * ask. This is the declaration that could not be written before, and it has
   * to reach the snapshot for any of the rest to be reachable.
   */
  it("carries a declared fulltext index type into the snapshot", () => {
    const Post = s
      .model({ id: s.string().id(), body: s.string() })
      .index(["body"], { type: "fulltext" });

    const snapshot = serialize({ post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([
      expect.objectContaining({ columns: ["body"], type: "fulltext" }),
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
      posts: s.toMany(() => Post),
    });

    const Post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => User)
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
      posts: s.toMany(() => Post),
    });

    const Post = s.model({
      id: s.string().id(),
      authorId: s.string().map("author_id"),
      author: s
        .toOne(() => User)
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
        members: s.toMany(() => Member),
      })
      .id(["tenantId", "code"]);

    const Member = s.model({
      id: s.string().id(),
      orgTenantId: s.string(),
      orgCode: s.string(),
      org: s
        .toOne(() => Org)
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
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .toOne(() => User)
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
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string().map("author_id"),
        author: s
          .toOne(() => User)
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
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        createdAt: s.string(),
        author: s
          .toOne(() => User)
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
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        createdAt: s.string(),
        author: s
          .toOne(() => User)
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

  // RE-FOUNDED (§9.4, FK009): a unique key over EXACTLY a plural edge's foreign
  // key now contradicts the collection and is refused at the gate, so the
  // coverage this cell exists for — a declared unique constraint suppressing the
  // automatic FK index — is reached through a COMPOUND unique the FK prefixes.
  it("skips the index when a declared unique prefixes the FK column", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        slug: s.string(),
        author: s
          .toOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .unique(["authorId", "slug"]);

    const snapshot = serialize({ user: User, post: Post });

    expect(snapshot.tables.find((t) => t.name === "post")!.indexes).toEqual([]);
  });

  it("skips the index when the FK columns prefix the primary key", () => {
    const Post = s.model({
      id: s.string().id(),
      tags: s.toMany(() => PostTag),
    });

    const Tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => PostTag),
    });

    // An explicit junction model: its PK already indexes (postId, tagId), so
    // the FK to post is covered and only the FK to tag needs an index.
    const PostTag = s
      .model({
        postId: s.string(),
        tagId: s.string(),
        post: s
          .toOne(() => Post)
          .fields("postId")
          .references("id"),
        tag: s
          .toOne(() => Tag)
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
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        published: s.boolean(),
        author: s
          .toOne(() => User)
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
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string().map("author_id"),
        published: s.boolean(),
        author: s
          .toOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      .index(["authorId"], { where: "published = true" });

    const snapshot = serialize({ user: User, post: Post });

    expect(
      snapshot.tables.find((t) => t.name === "post")!.indexes.map((i) => i.name)
    ).toEqual(["post_authorId_idx", "post_author_id_idx"]);
  });

  // REGRESSION (PR #20 review): the fallback covered only HALF the invariant it
  // exists for. Both candidate names are ordinary strings a schema may declare
  // — `.index([...], { name: "post_authorId_fkey_idx" })` is legal — and with
  // both taken the automatic index was pushed anyway, putting two entries under
  // one name into the snapshot. The differ then emitted two `CREATE INDEX` for
  // that name and the second failed the whole push (measured on better-sqlite3:
  // `index post_authorId_fkey_idx already exists`). The index is a read
  // optimization, so it yields; the schema's own names win.
  it("emits no FK index when the schema holds both candidate names", () => {
    const User = s.model({
      id: s.string().id(),
      posts: s.toMany(() => Post),
    });

    const Post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        title: s.string(),
        author: s
          .toOne(() => User)
          .fields("authorId")
          .references("id"),
      })
      // Neither declared index COVERS `authorId`, so neither suppresses the
      // FK index on coverage grounds — they only take its two names.
      .index(["title"], { name: "post_authorId_idx" })
      .index(["id"], { name: "post_authorId_fkey_idx" });

    const snapshot = serialize({ user: User, post: Post });

    expect(
      snapshot.tables
        .find((t) => t.name === "post")!
        .indexes.map((i) => `${i.name}(${i.columns.join(",")})`)
    ).toEqual(["post_authorId_idx(title)", "post_authorId_fkey_idx(id)"]);
  });

  it("adds no FK index for a oneToOne relation", () => {
    const User = s.model({
      id: s.string().id(),
      profile: s.toOne(() => Profile),
    });

    const Profile = s.model({
      id: s.string().id(),
      userId: s.string(),
      user: s
        .toOne(() => User)
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
      profile: s.toOne(() => Profile),
    });

    const Profile = s
      .model({
        id: s.string().id(),
        userId: s.string(),
        user: s
          .toOne(() => User)
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
      profile: s.toOne(() => Profile),
    });

    const Profile = s
      .model({
        id: s.string().id(),
        userId: s.string(),
        active: s.boolean(),
        user: s
          .toOne(() => User)
          .fields("userId")
          .references("id"),
      })
      .index(["userId"], { unique: true, where: "active = true" });

    const snapshot = serialize({ user: User, profile: Profile });

    expect(
      snapshot.tables.find((t) => t.name === "profile")!.uniqueConstraints
    ).toEqual([{ name: "profile_userId_key", columns: ["userId"] }]);
  });

  // REGRESSION (PR #20 review): the coverage scan read `uniqueConstraints` while
  // the 1:1 branch was still APPENDING to it, so a model naming the same columns
  // from a `manyToOne` and from a `oneToOne` answered by declaration order. Both
  // spellings are serialized here and the FK index has to be absent from both:
  // the 1:1 constraint covers the column either way, and which relation the
  // schema happens to list first is not a fact about the database.
  it.each([
    ["manyToOne first", true],
    ["oneToOne first", false],
  ])("emits no FK index when a 1:1 on the same columns makes them unique (%s)", (_name, manyFirst) => {
    // TWO named pairs over one column: one plural (which wants the FK index)
    // and one singular (which emits the unique constraint that covers it).
    const Target = s.model({
      id: s.string().id(),
      n: s.string(),
      children: s.toMany(() => Child).name("plural"),
      child: s.toOne(() => Child).name("singular"),
    });
    const manyRelation = s
      .toOne(() => Target)
      .name("plural")
      .fields("ownerId")
      .references("id");
    const oneRelation = s
      .toOne(() => Target)
      .name("singular")
      .fields("ownerId")
      .references("id");
    const Child = s.model({
      id: s.string().id(),
      ownerId: s.string(),
      ...(manyFirst
        ? { many: manyRelation, one: oneRelation }
        : { one: oneRelation, many: manyRelation }),
    });

    const childTable = serialize({ target: Target, child: Child }).tables.find(
      (t) => t.name === "child"
    );

    expect(childTable!.indexes).toEqual([]);
    expect(childTable!.uniqueConstraints).toEqual([
      { name: "child_ownerId_key", columns: ["ownerId"] },
    ]);
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

// =============================================================================
// THE SERIALIZER IS GATE-BOUND
// =============================================================================

/**
 * RE-FOUNDED (plan §7.3, §10 Package E item 6). This block used to pin the
 * serializer's OWN junction pair-reconciliation refusals and the order it asked
 * its questions in — a cross-side A/B merge that no longer exists: exactly one
 * endpoint owns every junction override (§4.4, R011), so there is nothing to
 * reconcile, and the physical owner's refusal ORDER is pinned by its own suite
 * (`tests/unit/relations/junction-topology.core.test.ts`).
 *
 * What survives is the one fact only this file can state: `serializeModels`
 * cannot see an unproven schema. Its public surface hydrates and resolves for
 * itself, so every refusal the definition gate owns lands before a single
 * column of DDL exists — the hazard being closed is a direct
 * `serializeModels(...)` call emitting DDL for a topology nothing proved.
 */
describe("serializeModels is gate-bound", () => {
  /** Hydrate outside the capture so only serialization refusals are pinned. */
  function serializationError(schema: Record<string, any>): unknown {
    hydrateSchemaNames(schema);
    try {
      serializeModels(schema, { migrationDriver: postgresMigrationDriver });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("refuses a schema whose junction is configured on both endpoints", () => {
    const Post = s.model({
      id: s.string().id(),
      tags: s.toMany(() => Tag).onDelete("cascade"),
    });
    const Tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => Post).onDelete("restrict"),
    });

    const thrown = serializationError({ post: Post, tag: Tag });

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected serialization to throw.");
    }
    expect(thrown.message).toContain("[R011]");
    expect(thrown.message).toContain("'post.tags' and 'tag.posts'");
  });

  it("ignores a hostile relations option and resolves the public schema", () => {
    const missing = s.model({ id: s.string().id() });
    const owner = s.model({
      id: s.string().id(),
      missing: s.toOne(() => missing),
    });

    expect(() =>
      Reflect.apply(serializeModels, undefined, [
        { owner },
        { migrationDriver: postgresMigrationDriver, relations: new Map() },
      ])
    ).toThrow("[R006]");
  });

  it("publishes no snapshot for a target covered only by a partial unique index", () => {
    const user = s
      .model({
        id: s.string().id(),
        handle: s.string(),
        posts: s.toMany(() => post),
      })
      .index(["handle"], { unique: true, where: "handle IS NOT NULL" });
    const post = s.model({
      id: s.string().id(),
      authorHandle: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorHandle")
        .references("handle"),
    });

    expect(() =>
      serializeModels(
        { user, post },
        {
          migrationDriver: postgresMigrationDriver,
        }
      )
    ).toThrow("[FK005]");
  });

  it("serializes a foreign key to a predicate-free unique index", () => {
    const user = s
      .model({
        id: s.string().id(),
        handle: s.string(),
        posts: s.toMany(() => post),
      })
      .index(["handle"], { unique: true });
    const post = s.model({
      id: s.string().id(),
      authorHandle: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorHandle")
        .references("handle"),
    });
    const snapshot = serializeModels(
      { user, post },
      { migrationDriver: postgresMigrationDriver }
    );

    expect(
      snapshot.tables.find((table) => table.name === "post")?.foreignKeys
    ).toEqual([
      expect.objectContaining({
        columns: ["authorHandle"],
        referencedColumns: ["handle"],
      }),
    ]);
  });

  it("refuses one junction table claimed by two distinct pairs", () => {
    const Post = s.model({
      id: s.string().id(),
      tags: s.toMany(() => Tag).through("shared_junction"),
    });
    const Tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => Post),
    });
    const User = s.model({
      id: s.string().id(),
      roles: s.toMany(() => Role).through("shared_junction"),
    });
    const Role = s.model({
      id: s.string().id(),
      users: s.toMany(() => User),
    });

    const thrown = serializationError({
      post: Post,
      tag: Tag,
      user: User,
      role: Role,
    });

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected serialization to throw.");
    }
    expect(thrown.message).toContain("[JT001]");
    expect(thrown.message).toContain("shared_junction");
  });
});

// =============================================================================
// DECIMAL DESCRIPTOR SERIALIZATION
// =============================================================================

describe("decimal descriptor serialization", () => {
  it("carries the ONE frozen domain onto every column, by reference", () => {
    const domain = { precision: 10, scale: 5 };
    const amount = s.decimal(domain);
    const Ledger = s.model({
      id: s.string().id(),
      amount,
      optional: amount.nullable(),
      renamed: amount.map("renamed_column"),
      seeded: amount.default("12.34"),
      samples: amount.array(),
    });

    const schema = { ledger: Ledger };
    hydrateSchemaNames(schema);
    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    const columns = new Map(
      (snapshot.tables[0]?.columns ?? []).map((column) => [column.name, column])
    );

    // Every modifier preserves the descriptor, and `.map()` moves the COLUMN
    // NAME without moving the domain.
    for (const name of ["amount", "optional", "renamed_column", "seeded"]) {
      expect(columns.get(name)?.decimal).toEqual({ precision: 10, scale: 5 });
    }
    expect(columns.get("samples")?.decimal).toEqual({
      precision: 10,
      scale: 5,
    });

    // The SAME object, not a copy: the descriptor is the one frozen fact the
    // resolved scalar owns, and a migration copy of it would be a second
    // precision decision the plan forbids.
    const declared = amount["~"].state.decimal;
    expect(columns.get("amount")?.decimal).toBe(declared);
    expect(columns.get("samples")?.decimal).toBe(declared);

    // A scalar with no domain carries none — the key is not written blank.
    expect(columns.get("id")?.decimal).toBeUndefined();
  });
});
