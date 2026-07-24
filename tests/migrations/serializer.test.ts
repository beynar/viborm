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
