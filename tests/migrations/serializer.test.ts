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

  it("foreign keys have default noAction cascade behavior", () => {
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
      expect(fk.onDelete).toBe("noAction");
      expect(fk.onUpdate).toBe("noAction");
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
