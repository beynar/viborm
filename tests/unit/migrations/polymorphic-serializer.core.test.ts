import type { MigrationDriver } from "@src/migrations/drivers";
import { libsqlMigrationDriver } from "@src/migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchema, validateSchemaOrThrow } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

const RELATION_CONSTRAINT_KEYWORDS = /\b(?:FOREIGN KEY|CHECK|UNIQUE)\b/i;
const CREATE_UNIQUE_INDEX = /CREATE UNIQUE INDEX/;

function polymorphicSchema(optional = false) {
  const post = s
    .model({ id: s.string().id().map("post_pk"), title: s.string() })
    .map("articles");
  const video = s
    .model({ id: s.string().id().map("video_pk"), title: s.string() })
    .map("clips");
  const relation = s.polymorphicToOne(
    { post: () => post, video: () => video },
    {
      values: {
        post: "content.post.v1",
        video: "content.video.v1",
      },
    }
  );
  const comment = s
    .model({
      id: s.string().id(),
      subject: optional ? relation.optional() : relation,
    })
    .map("comments");
  const schema = { post, video, comment };
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
  return schema;
}

function polymorphicOneToOneSchema() {
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
  const schema = { post, video, comment };
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
  return schema;
}

describe("polymorphic migration serialization", () => {
  const ddlCases: ReadonlyArray<{
    name: string;
    driver: MigrationDriver;
    requiredTypeColumn: string;
    requiredIdColumn: string;
    optionalTypeColumn: string;
    optionalIdColumn: string;
    index: string;
  }> = [
    {
      name: "PostgreSQL",
      driver: postgresMigrationDriver,
      requiredTypeColumn: '"subject_type" text NOT NULL',
      requiredIdColumn: '"subject_id" text NOT NULL',
      optionalTypeColumn: '"subject_type" text',
      optionalIdColumn: '"subject_id" text',
      index:
        'CREATE INDEX "comments_subject_poly_idx" ON "comments" ("subject_type", "subject_id")',
    },
    {
      name: "MySQL",
      driver: mysqlMigrationDriver,
      requiredTypeColumn: "`subject_type` VARCHAR(191) NOT NULL",
      requiredIdColumn: "`subject_id` VARCHAR(191) NOT NULL",
      optionalTypeColumn: "`subject_type` VARCHAR(191)",
      optionalIdColumn: "`subject_id` VARCHAR(191)",
      index:
        "CREATE INDEX `comments_subject_poly_idx` ON `comments` (`subject_type`, `subject_id`)",
    },
    {
      name: "SQLite",
      driver: sqlite3MigrationDriver,
      requiredTypeColumn: '"subject_type" TEXT NOT NULL',
      requiredIdColumn: '"subject_id" TEXT NOT NULL',
      optionalTypeColumn: '"subject_type" TEXT',
      optionalIdColumn: '"subject_id" TEXT',
      index:
        'CREATE INDEX "comments_subject_poly_idx" ON "comments" ("subject_type", "subject_id")',
    },
    {
      name: "libSQL",
      driver: libsqlMigrationDriver,
      requiredTypeColumn: '"subject_type" TEXT NOT NULL',
      requiredIdColumn: '"subject_id" TEXT NOT NULL',
      optionalTypeColumn: '"subject_type" TEXT',
      optionalIdColumn: '"subject_id" TEXT',
      index:
        'CREATE INDEX "comments_subject_poly_idx" ON "comments" ("subject_type", "subject_id")',
    },
  ];

  it.each(
    ddlCases
  )("$name emits private columns and their ordered index without relation constraints", ({
    driver,
    requiredTypeColumn,
    requiredIdColumn,
    optionalTypeColumn,
    optionalIdColumn,
    index,
  }) => {
    const requiredOwner = serializeModels(polymorphicSchema(), {
      migrationDriver: driver,
    }).tables.find((table) => table.name === "comments");
    const optionalOwner = serializeModels(polymorphicSchema(true), {
      migrationDriver: driver,
    }).tables.find((table) => table.name === "comments");
    if (!(requiredOwner && optionalOwner)) {
      throw new Error("Polymorphic owner table was not serialized");
    }

    const requiredDdl = driver.generateDDL({
      type: "createTable",
      table: requiredOwner,
    });
    const optionalDdl = driver.generateDDL({
      type: "createTable",
      table: optionalOwner,
    });

    expect(requiredDdl).toContain(requiredTypeColumn);
    expect(requiredDdl).toContain(requiredIdColumn);
    expect(requiredDdl).toContain(index);
    expect(requiredDdl).not.toMatch(RELATION_CONSTRAINT_KEYWORDS);
    expect(optionalDdl).toContain(optionalTypeColumn);
    expect(optionalDdl).toContain(optionalIdColumn);
    expect(optionalDdl).not.toContain(`${optionalTypeColumn} NOT NULL`);
    expect(optionalDdl).not.toContain(`${optionalIdColumn} NOT NULL`);
  });

  it("emits required private storage, its composite index, the storage registry, and logical member metadata", () => {
    const snapshot = serializeModels(polymorphicSchema(), {
      migrationDriver: postgresMigrationDriver,
    });
    const owner = snapshot.tables.find((table) => table.name === "comments");

    expect(owner?.columns).toEqual(
      expect.arrayContaining([
        { name: "subject_type", type: "text", nullable: false },
        { name: "subject_id", type: "text", nullable: false },
      ])
    );
    expect(owner?.indexes).toContainEqual({
      name: "comments_subject_poly_idx",
      columns: ["subject_type", "subject_id"],
      unique: false,
    });
    expect(owner?.foreignKeys).toEqual([]);
    expect(owner?.uniqueConstraints).toEqual([]);
    // The physical facts stay in the TableDef (columns and index above); the
    // registry annotates which of them are relation-owned, keyed by the
    // storage ref the metadata entry joins through.
    expect(owner?.relationStorage).toEqual({
      subject_type: {
        kind: "polymorphicToOne",
        typeColumn: "subject_type",
        idColumn: "subject_id",
        index: "comments_subject_poly_idx",
      },
    });
    // Generated-file member history is logical-only (§11.1): no column names,
    // no referenced columns, no constraint names.
    expect(snapshot.polymorphicStorage).toEqual([
      {
        ownerTable: "comments",
        relation: "subject",
        kind: "toOne",
        storageRef: "subject_type",
        members: [
          {
            publicType: "post",
            storedType: "content.post.v1",
            targetTable: "articles",
          },
          {
            publicType: "video",
            storedType: "content.video.v1",
            targetTable: "clips",
          },
        ],
      },
    ]);
  });

  it("makes the existing composite index unique for a singular inverse", () => {
    const snapshot = serializeModels(polymorphicOneToOneSchema(), {
      migrationDriver: postgresMigrationDriver,
    });
    const owner = snapshot.tables.find((table) => table.name === "comment");

    expect(owner?.indexes).toContainEqual({
      name: "comment_commentable_poly_idx",
      columns: ["commentable_type", "commentable_id"],
      unique: true,
    });
  });

  it.each(
    ddlCases
  )("$name emits the singular storage index as unique without changing its identity", ({
    driver,
  }) => {
    const owner = serializeModels(polymorphicOneToOneSchema(), {
      migrationDriver: driver,
    }).tables.find((table) => table.name === "comment");
    if (!owner) throw new Error("Polymorphic owner table was not serialized");

    const ddl = driver.generateDDL({ type: "createTable", table: owner });

    expect(ddl).toMatch(CREATE_UNIQUE_INDEX);
    expect(ddl).toContain("comment_commentable_poly_idx");
  });

  it("makes both private columns nullable only for an optional relation", () => {
    const snapshot = serializeModels(polymorphicSchema(true), {
      migrationDriver: postgresMigrationDriver,
    });
    const owner = snapshot.tables.find((table) => table.name === "comments");
    const storageColumns = owner?.columns.filter((column) =>
      column.name.startsWith("subject_")
    );

    expect(storageColumns).toEqual([
      { name: "subject_type", type: "text", nullable: true },
      { name: "subject_id", type: "text", nullable: true },
    ]);
  });

  it("lets the dialect finalize indexed storage without adding scalar behavior", () => {
    const snapshot = serializeModels(polymorphicSchema(), {
      migrationDriver: mysqlMigrationDriver,
    });
    const owner = snapshot.tables.find((table) => table.name === "comments");

    expect(
      owner?.columns.filter((column) => column.name.startsWith("subject_"))
    ).toEqual([
      { name: "subject_type", type: "VARCHAR(191)", nullable: false },
      { name: "subject_id", type: "VARCHAR(191)", nullable: false },
    ]);
  });

  it("does not inherit target identity generation on the private id column", () => {
    const post = s.model({ id: s.int().id().increment() });
    const video = s.model({ id: s.int().id().increment() });
    const comment = s.model({
      id: s.string().id(),
      subject: s.polymorphicToOne(
        { post: () => post, video: () => video },
        { values: { post: "content.post.v1", video: "content.video.v1" } }
      ),
    });
    const schema = { post, video, comment };
    hydrateSchemaNames(schema);
    validateSchemaOrThrow(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    const owner = snapshot.tables.find((table) => table.name === "comment");

    expect(
      owner?.columns.filter((column) => column.name.startsWith("subject_"))
    ).toEqual([
      { name: "subject_type", type: "text", nullable: false },
      { name: "subject_id", type: "integer", nullable: false },
    ]);
  });

  it("leaves ordinary snapshot shape unchanged", () => {
    const user = s.model({ id: s.string().id(), email: s.string().unique() });
    const schema = { user };
    hydrateSchemaNames(schema);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    expect(Object.keys(snapshot)).toEqual(["tables", "enums"]);
    expect(snapshot).not.toHaveProperty("polymorphicStorage");
    expect(snapshot.tables[0]).not.toHaveProperty("relationStorage");
  });
});

// =============================================================================
// B3 MEMBER-TABLE SERIALIZATION — the §13.2 DDL pin matrix, driven through
// `serializeModels` over a schema that validates CLEAN. (While P014 stood,
// this matrix ran against a schema whose only errors were that blanket
// refusal; deleting it is what turned these fixtures into ordinary valid
// schemas.)
// =============================================================================

/**
 * The matrix schema: compound owner key, scalar string target (post, singular
 * inverse — its unique side is REDUNDANT with the reverse index by canonical
 * order, deliberately), integer target (video, plural), mapped compound target
 * (doc, singular inverse, sorts canonical-FIRST so its unique side and the
 * reverse index cover DIFFERENT sides), a self target (parent), equal logical
 * `id` fields in two targets, an explicit `.through()` relation, and two named
 * polymorphic fields between the same models.
 */
function memberMatrixSchema() {
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    galleryOwner: s
      .manyToOne(() => owner)
      .name("gallery")
      .optional(),
  });
  const video = s.model({ id: s.int().id() });
  const doc = s
    .model({
      region: s.string().map("region_code"),
      serial: s.string().map("serial_no"),
      galleryOwner: s
        .manyToOne(() => owner)
        .name("gallery")
        .optional(),
    })
    .id(["region", "serial"])
    .map("legal_documents");
  const owner = s
    .model({
      tenantId: s.string(),
      localId: s.string(),
      gallery: s
        .polymorphicToMany(
          {
            post: () => post,
            video: () => video,
            doc: () => doc,
            parent: () => owner,
          },
          {
            values: {
              post: "gallery.post",
              video: "gallery.video",
              doc: "gallery.doc",
              parent: "gallery.parent",
            },
          }
        )
        .name("gallery"),
      attachments: s
        .polymorphicToMany(
          { post: () => post, video: () => video },
          {
            values: {
              post: "attachments.post",
              video: "attachments.video",
            },
          }
        )
        .name("attachments")
        .through({
          post: {
            table: "owner_attachment_links",
            source: "owner_ref",
            target: "post_ref",
          },
          video: {
            table: "owner_video_links",
            source: "owner_ref",
            target: "video_ref",
          },
        }),
    })
    .id(["tenantId", "localId"]);
  const schema = { post, video, doc, owner };
  hydrateSchemaNames(schema);
  const errorCodes = validateSchema(schema).errors.map((entry) => entry.code);
  // The matrix schema is VALID — nothing at all. Load-bearing: a member whose
  // validation failed stores no descriptor, so the serializer would emit no
  // table for it and the DDL pins below would silently measure an empty set.
  if (errorCodes.length > 0) {
    throw new Error(
      `matrix schema must validate clean, got: ${errorCodes.join(",")}`
    );
  }
  return { schema, owner };
}

describe("polymorphic member-table serialization", () => {
  it("emits the exact member TableDef matrix on PostgreSQL", () => {
    const { schema } = memberMatrixSchema();
    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    // Deterministic table order: model tables (schema order), then member
    // junction tables (model iteration order, member declaration order) —
    // ordinary junctions would follow after (none exist in this schema).
    expect(snapshot.tables.map((table) => table.name)).toEqual([
      "post",
      "video",
      "legal_documents",
      "owner",
      "owner_gallery_post",
      "owner_gallery_video",
      "owner_gallery_doc",
      "owner_gallery_parent",
      "owner_attachment_links",
      "owner_video_links",
    ]);
    const byName = new Map(snapshot.tables.map((table) => [table.name, table]));

    // Default naming (`${ownerTable}_${relationField}_${publicType}`), scalar
    // string target, compound owner side, canonical owner-first order, and the
    // ACCEPTED REDUNDANCY: this singular-inverse target sorts canonical-second,
    // so the unconditional reverse index and the unique side cover the same
    // column — DDL shape is uniform, never conditional on sort order.
    expect(byName.get("owner_gallery_post")).toEqual({
      name: "owner_gallery_post",
      columns: [
        { name: "owner_1", type: "text", nullable: false },
        { name: "owner_2", type: "text", nullable: false },
        { name: "postId", type: "text", nullable: false },
      ],
      primaryKey: { columns: ["owner_1", "owner_2", "postId"] },
      indexes: [
        {
          name: "owner_gallery_post_postId_idx",
          columns: ["postId"],
          unique: false,
        },
      ],
      foreignKeys: [
        {
          name: "owner_gallery_post_owner_fkey",
          columns: ["owner_1", "owner_2"],
          referencedTable: "owner",
          referencedColumns: ["tenantId", "localId"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
        {
          name: "owner_gallery_post_postId_fkey",
          columns: ["postId"],
          referencedTable: "post",
          referencedColumns: ["id"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      ],
      uniqueConstraints: [
        { name: "owner_gallery_post_postId_key", columns: ["postId"] },
      ],
    });

    // Integer target with a logical `id` equal to post's — the variant-derived
    // token keeps the junction columns distinct. Plural inverse: the unique
    // target side is ABSENT.
    expect(byName.get("owner_gallery_video")).toEqual({
      name: "owner_gallery_video",
      columns: [
        { name: "owner_1", type: "text", nullable: false },
        { name: "owner_2", type: "text", nullable: false },
        { name: "videoId", type: "integer", nullable: false },
      ],
      primaryKey: { columns: ["owner_1", "owner_2", "videoId"] },
      indexes: [
        {
          name: "owner_gallery_video_videoId_idx",
          columns: ["videoId"],
          unique: false,
        },
      ],
      foreignKeys: [
        {
          name: "owner_gallery_video_owner_fkey",
          columns: ["owner_1", "owner_2"],
          referencedTable: "owner",
          referencedColumns: ["tenantId", "localId"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
        {
          name: "owner_gallery_video_videoId_fkey",
          columns: ["videoId"],
          referencedTable: "video",
          referencedColumns: ["id"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      ],
      uniqueConstraints: [],
    });

    // Mapped compound target that sorts canonical-FIRST: the reverse index
    // covers the OWNER side while the unique constraint covers the complete
    // ordered TARGET side — the two are DIFFERENT column sets here, which is
    // why the unique side is never "the reverse index flipped". The FKs
    // reference the MAPPED target columns. The PK carries no name.
    expect(byName.get("owner_gallery_doc")).toEqual({
      name: "owner_gallery_doc",
      columns: [
        { name: "doc_1", type: "text", nullable: false },
        { name: "doc_2", type: "text", nullable: false },
        { name: "owner_1", type: "text", nullable: false },
        { name: "owner_2", type: "text", nullable: false },
      ],
      primaryKey: { columns: ["doc_1", "doc_2", "owner_1", "owner_2"] },
      indexes: [
        {
          name: "owner_gallery_doc_owner_idx",
          columns: ["owner_1", "owner_2"],
          unique: false,
        },
      ],
      foreignKeys: [
        {
          name: "owner_gallery_doc_doc_fkey",
          columns: ["doc_1", "doc_2"],
          referencedTable: "legal_documents",
          referencedColumns: ["region_code", "serial_no"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
        {
          name: "owner_gallery_doc_owner_fkey",
          columns: ["owner_1", "owner_2"],
          referencedTable: "owner",
          referencedColumns: ["tenantId", "localId"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      ],
      uniqueConstraints: [
        { name: "owner_gallery_doc_doc_key", columns: ["doc_1", "doc_2"] },
      ],
    });

    // Self target: the variant-derived token keeps both compound sides
    // distinct, and both fixed-cascade FKs reference the owner itself.
    expect(byName.get("owner_gallery_parent")).toEqual({
      name: "owner_gallery_parent",
      columns: [
        { name: "owner_1", type: "text", nullable: false },
        { name: "owner_2", type: "text", nullable: false },
        { name: "parent_1", type: "text", nullable: false },
        { name: "parent_2", type: "text", nullable: false },
      ],
      primaryKey: {
        columns: ["owner_1", "owner_2", "parent_1", "parent_2"],
      },
      indexes: [
        {
          name: "owner_gallery_parent_parent_idx",
          columns: ["parent_1", "parent_2"],
          unique: false,
        },
      ],
      foreignKeys: [
        {
          name: "owner_gallery_parent_owner_fkey",
          columns: ["owner_1", "owner_2"],
          referencedTable: "owner",
          referencedColumns: ["tenantId", "localId"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
        {
          name: "owner_gallery_parent_parent_fkey",
          columns: ["parent_1", "parent_2"],
          referencedTable: "owner",
          referencedColumns: ["tenantId", "localId"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      ],
      uniqueConstraints: [],
    });

    // Explicit `.through()` overrides all three names — table and both side
    // tokens — for every member of the relation.
    expect(byName.get("owner_attachment_links")).toEqual({
      name: "owner_attachment_links",
      columns: [
        { name: "owner_ref_1", type: "text", nullable: false },
        { name: "owner_ref_2", type: "text", nullable: false },
        { name: "post_ref", type: "text", nullable: false },
      ],
      primaryKey: { columns: ["owner_ref_1", "owner_ref_2", "post_ref"] },
      indexes: [
        {
          name: "owner_attachment_links_post_ref_idx",
          columns: ["post_ref"],
          unique: false,
        },
      ],
      foreignKeys: [
        {
          name: "owner_attachment_links_owner_ref_fkey",
          columns: ["owner_ref_1", "owner_ref_2"],
          referencedTable: "owner",
          referencedColumns: ["tenantId", "localId"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
        {
          name: "owner_attachment_links_post_ref_fkey",
          columns: ["post_ref"],
          referencedTable: "post",
          referencedColumns: ["id"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
      ],
      uniqueConstraints: [],
    });
    expect(byName.get("owner_video_links")?.columns).toEqual([
      { name: "owner_ref_1", type: "text", nullable: false },
      { name: "owner_ref_2", type: "text", nullable: false },
      { name: "video_ref", type: "integer", nullable: false },
    ]);
  });

  it("finalizes member tables per dialect", () => {
    const { schema } = memberMatrixSchema();

    // MySQL post-finalize: every keyed TEXT column becomes VARCHAR(191) —
    // member junctions inherit the driver's finalizeTable for free.
    const mysqlTables = new Map(
      serializeModels(schema, {
        migrationDriver: mysqlMigrationDriver,
      }).tables.map((table) => [table.name, table])
    );
    expect(mysqlTables.get("owner_gallery_video")?.columns).toEqual([
      { name: "owner_1", type: "VARCHAR(191)", nullable: false },
      { name: "owner_2", type: "VARCHAR(191)", nullable: false },
      { name: "videoId", type: "INT", nullable: false },
    ]);
    // The singular member's unique target side arrives as a unique INDEX on
    // MySQL, not a unique constraint: MySQL has one unique namespace, so the
    // driver's `finalizeTable` folds the constraint bucket into the index
    // bucket and introspection reads uniques back the same way. Without that
    // canonicalization a unique-bearing MySQL schema never converges — the
    // second push planned a spurious `dropIndex` forever (measured on docker
    // MySQL 8; the empty second push is pinned by the MySQL leg of
    // `polymorphic-member-junction-behavior`).
    expect(mysqlTables.get("owner_gallery_doc")).toMatchObject({
      columns: [
        { name: "doc_1", type: "VARCHAR(191)", nullable: false },
        { name: "doc_2", type: "VARCHAR(191)", nullable: false },
        { name: "owner_1", type: "VARCHAR(191)", nullable: false },
        { name: "owner_2", type: "VARCHAR(191)", nullable: false },
      ],
      uniqueConstraints: [],
    });
    expect(mysqlTables.get("owner_gallery_doc")?.indexes).toContainEqual({
      name: "owner_gallery_doc_doc_key",
      columns: ["doc_1", "doc_2"],
      unique: true,
    });
    // PostgreSQL keeps the two buckets distinct, so the same member table
    // carries a real unique CONSTRAINT there — the divergence is the driver's,
    // not the serializer's.
    expect(
      new Map(
        serializeModels(schema, {
          migrationDriver: postgresMigrationDriver,
        }).tables.map((table) => [table.name, table])
      ).get("owner_gallery_doc")?.uniqueConstraints
    ).toEqual([
      { name: "owner_gallery_doc_doc_key", columns: ["doc_1", "doc_2"] },
    ]);

    // SQLite affinities, same shape otherwise.
    const sqliteTables = new Map(
      serializeModels(schema, {
        migrationDriver: sqlite3MigrationDriver,
      }).tables.map((table) => [table.name, table])
    );
    expect(sqliteTables.get("owner_gallery_video")?.columns).toEqual([
      { name: "owner_1", type: "TEXT", nullable: false },
      { name: "owner_2", type: "TEXT", nullable: false },
      { name: "videoId", type: "INTEGER", nullable: false },
    ]);
    expect(sqliteTables.get("owner_gallery_video")?.primaryKey).toEqual({
      columns: ["owner_1", "owner_2", "videoId"],
    });
  });

  it("emits logical-only toMany member metadata", () => {
    const { schema } = memberMatrixSchema();
    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });

    expect(snapshot.polymorphicStorage).toEqual([
      {
        ownerTable: "owner",
        relation: "gallery",
        kind: "toMany",
        members: [
          {
            publicType: "post",
            storedType: "gallery.post",
            targetTable: "post",
            memberJunctionTable: "owner_gallery_post",
            inverseCardinality: "one",
          },
          {
            publicType: "video",
            storedType: "gallery.video",
            targetTable: "video",
            memberJunctionTable: "owner_gallery_video",
            inverseCardinality: "many",
          },
          {
            publicType: "doc",
            storedType: "gallery.doc",
            targetTable: "legal_documents",
            memberJunctionTable: "owner_gallery_doc",
            inverseCardinality: "one",
          },
          {
            publicType: "parent",
            storedType: "gallery.parent",
            targetTable: "owner",
            memberJunctionTable: "owner_gallery_parent",
            inverseCardinality: "many",
          },
        ],
      },
      {
        ownerTable: "owner",
        relation: "attachments",
        kind: "toMany",
        members: [
          {
            publicType: "post",
            storedType: "attachments.post",
            targetTable: "post",
            memberJunctionTable: "owner_attachment_links",
            inverseCardinality: "many",
          },
          {
            publicType: "video",
            storedType: "attachments.video",
            targetTable: "video",
            memberJunctionTable: "owner_video_links",
            inverseCardinality: "many",
          },
        ],
      },
    ]);
    // toMany members carry NO relationStorage registry — that annotation is
    // toOne-only.
    const memberTable = snapshot.tables.find(
      (table) => table.name === "owner_gallery_post"
    );
    expect(memberTable).not.toHaveProperty("relationStorage");
  });

  it("serializes every physical name from the stored topology alone", () => {
    const { schema, owner } = memberMatrixSchema();
    const storage = owner["~"].getPolymorphicStorage("gallery");
    if (storage?.kind !== "toMany") {
      throw new Error("gallery storage must be a toMany descriptor");
    }
    const docJunction = storage.members.get("doc")?.junction;
    if (!docJunction) throw new Error("doc member must exist");

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    const docTable = snapshot.tables.find(
      (table) => table.name === docJunction.table
    );

    // The serializer's names byte-equal the topology's own methods — no
    // reconstruction from naming conventions anywhere.
    expect(docTable?.indexes.map((index) => index.name)).toEqual([
      docJunction.reverseIndexName(),
    ]);
    expect(docTable?.foreignKeys.map((fk) => fk.name).sort()).toEqual(
      [
        docJunction.foreignKeyName("source"),
        docJunction.foreignKeyName("target"),
      ].sort()
    );
    expect(docTable?.uniqueConstraints.map((unique) => unique.name)).toEqual([
      docJunction.uniqueTargetName(),
    ]);
  });

  it("excludes the bound manyToMany view while member tables and an ordinary pair emit", () => {
    const tag = s.model({
      id: s.string().id(),
      // The VIEW spelling of the collection inverse — and a HOSTILE
      // referential action on it (P016 refuses it at validation; the
      // serializer must still never let it reach DDL).
      holders: s
        .manyToMany(() => holder)
        .name("labels")
        .onDelete("restrict"),
    });
    const holder = s.model({
      id: s.string().id(),
      labels: s
        .polymorphicToMany(
          { tag: () => tag },
          { values: { tag: "labels.tag" } }
        )
        .name("labels"),
      categories: s.manyToMany(() => category),
    });
    const category = s.model({
      id: s.string().id(),
      holders: s.manyToMany(() => holder),
    });
    const schema = { tag, holder, category };
    hydrateSchemaNames(schema);
    const result = validateSchema(schema);
    // P016 alone — the view's forbidden physical configuration. The collection
    // declaration itself is legal.
    expect(result.errors.map((entry) => entry.code)).toEqual(["P016"]);

    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    const tableNames = snapshot.tables.map((table) => table.name);

    // The member table emits; the bound m2m view emits NO ordinary junction;
    // the ordinary pair beside it still emits — and member tables precede
    // ordinary junctions deterministically.
    const memberTable = snapshot.tables.find(
      (table) => table.name === "holder_labels_tag"
    );
    expect(memberTable).toBeDefined();
    const junctionNames = tableNames.filter(
      (name) => !["tag", "holder", "category"].includes(name)
    );
    expect(junctionNames[0]).toBe("holder_labels_tag");
    expect(junctionNames).toHaveLength(2);
    const ordinaryJunction = snapshot.tables.find(
      (table) => table.name === junctionNames[1]
    );
    expect(
      ordinaryJunction?.foreignKeys.map((fk) => fk.referencedTable).sort()
    ).toEqual(["category", "holder"]);

    // Hostile action never reaches DDL: the member junction's FKs are the
    // FIXED cascade pair regardless of the view's configured action.
    expect(
      memberTable?.foreignKeys.map((fk) => [fk.onDelete, fk.onUpdate])
    ).toEqual([
      ["cascade", "cascade"],
      ["cascade", "cascade"],
    ]);
  });

  it("refuses colliding member junction names at validation, before DDL", () => {
    const a = s.model({ id: s.string().id() });
    const clash = s.model({
      id: s.string().id(),
      items: s.polymorphicToMany({ a: () => a }, { values: { a: "items.a" } }),
      extra: s
        .polymorphicToMany({ a: () => a }, { values: { a: "extra.a" } })
        .name("extra")
        .through({
          // Explicitly claims the table name `items` generates.
          a: { table: "clash_items_a", source: "clashRef", target: "aRef" },
        }),
    });
    const schema = { a, clash };
    hydrateSchemaNames(schema);
    const result = validateSchema(schema);

    expect(result.errors.map((entry) => entry.code)).toEqual(["P019", "P019"]);
    // The refused members store no descriptor, so no DDL is ever emitted for
    // the colliding name.
    const snapshot = serializeModels(schema, {
      migrationDriver: postgresMigrationDriver,
    });
    expect(snapshot.tables.map((table) => table.name)).toEqual(["a", "clash"]);
  });
});
