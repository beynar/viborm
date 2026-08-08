import { describe, expect, it } from "vitest";
import type { MigrationDriver } from "@src/migrations/drivers";
import { libsqlMigrationDriver } from "@src/migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchemaOrThrow } from "@src/schema/validation";

function polymorphicSchema(optional = false) {
  const post = s
    .model({ id: s.string().id().map("post_pk"), title: s.string() })
    .map("articles");
  const video = s
    .model({ id: s.string().id().map("video_pk"), title: s.string() })
    .map("clips");
  const relation = s.polymorphic(
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

  it.each(ddlCases)(
    "$name emits private columns and their ordered index without relation constraints",
    ({
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
      expect(requiredDdl).not.toMatch(/\b(?:FOREIGN KEY|CHECK|UNIQUE)\b/i);
      expect(optionalDdl).toContain(optionalTypeColumn);
      expect(optionalDdl).toContain(optionalIdColumn);
      expect(optionalDdl).not.toContain(`${optionalTypeColumn} NOT NULL`);
      expect(optionalDdl).not.toContain(`${optionalIdColumn} NOT NULL`);
    }
  );

  it("emits required private storage, its composite index, and physical member metadata", () => {
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
    expect(snapshot.polymorphicStorage).toEqual([
      {
        ownerTable: "comments",
        relation: "subject",
        typeColumn: "subject_type",
        idColumn: "subject_id",
        members: [
          {
            publicType: "post",
            storedType: "content.post.v1",
            targetTable: "articles",
            referencedColumn: "post_pk",
          },
          {
            publicType: "video",
            storedType: "content.video.v1",
            targetTable: "clips",
            referencedColumn: "video_pk",
          },
        ],
      },
    ]);
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
      subject: s.polymorphic(
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
  });
});
