/**
 * The PostgreSQL `introspectSchema` contract, run against any PostgreSQL
 * driver: PGlite in the credential-free lane, a real server in the Docker lane.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers/driver";
import { createMigrationClient } from "@migrations";
import { diff } from "@migrations/differ";
import { getMigrationDriver } from "@migrations/drivers";
import { introspectSchema } from "@migrations/introspect";
import { serializeModels } from "@migrations/serializer";
import { parseSchema, serializeSchema } from "@schema/json";
import { describe, expect, it } from "vitest";
import {
  codedSchema,
  expectEmptyRoundTrip,
  expectLightDocument,
  RICH_POSTGRES_SQL,
  RICH_SKIPPED_SQL,
  RICH_TABLES,
} from "./_introspect-fixtures";

export interface PostgresEstate {
  /** A driver on an EMPTY namespace, freshly created. */
  fresh(): Promise<AnyDriver>;
}

async function run(driver: AnyDriver, statements: readonly string[]) {
  for (const statement of statements) await driver._executeRaw(statement, []);
}

export function postgresIntrospectionSuite(estate: PostgresEstate) {
  describe("a hand-written PostgreSQL database", () => {
    it("round-trips to an EMPTY push plan, and serves relation queries", async () => {
      const driver = await estate.fresh();
      await run(driver, RICH_POSTGRES_SQL);
      const { result, client } = await expectEmptyRoundTrip(
        driver,
        RICH_TABLES
      );
      const { document } = result;

      // Names are the database's own. `post_tag` is exactly the junction a
      // many-to-many generates, so it is that junction and not a model.
      expect(Object.keys(document.models).sort()).toEqual([
        "account",
        "category",
        "post",
        "profile",
        "tag",
      ]);
      const post = document.models.post!.fields;
      expect(post.author).toMatchObject({
        type: "toOne",
        target: "account",
        fields: ["author_id"],
        references: ["id"],
        onDelete: "cascade",
        name: "post_author_id_fkey",
      });
      expect(post.reviewer).toMatchObject({
        type: "toOne",
        target: "account",
        onDelete: "setNull",
        name: "post_reviewer_id_fkey",
      });
      const account = document.models.account!.fields;
      expect(account.post_by_author).toMatchObject({
        type: "toMany",
        target: "post",
      });
      expect(account.post_by_reviewer).toMatchObject({
        type: "toMany",
        target: "post",
      });
      expect(account.profile).toEqual({ type: "toOne", target: "profile" });
      expect(account.email).toEqual({
        type: "string",
        native: { db: "pg", type: "varchar(320)" },
        unique: true,
      });
      expect(account.role).toMatchObject({ type: "enum", default: "member" });
      expect(account.id).toMatchObject({
        type: "string",
        id: true,
        generate: { kind: "uuid" },
      });
      expect(document.models.category!.fields.parent).toMatchObject({
        type: "toOne",
        target: "category",
        name: "category_parent_id_fkey",
      });
      expect(document.models.category!.fields.category_by_parent).toMatchObject(
        {
          type: "toMany",
          target: "category",
        }
      );
      // The pure join table: a many-to-many on both ends.
      expect(post.tag).toMatchObject({ type: "toMany", target: "tag" });
      expect(document.models.tag!.fields.post).toMatchObject({
        type: "toMany",
        target: "post",
      });

      // Relation queries through the untyped client.
      const db = client as any;
      const author = await db.account.create({
        data: { email: "ada@example.com", display_name: "Ada" },
      });
      expect(author.role).toBe("member");
      expect(typeof author.id).toBe("string");
      const tag = await db.tag.create({ data: { label: "orm" } });
      const created = await db.post.create({
        data: {
          slug: "hello",
          title: "Hello",
          author: { connect: { id: author.id } },
          tag: { connect: [{ id: tag.id }] },
        },
        include: { author: true, tag: true },
      });
      expect(typeof created.id).toBe("bigint");
      expect(created.author.email).toBe("ada@example.com");
      expect(created.tag.map((item: { label: string }) => item.label)).toEqual([
        "orm",
      ]);
      const authors = await db.account.findMany({
        include: { post_by_author: { include: { tag: true } } },
      });
      expect(authors).toHaveLength(1);
      expect(authors[0].post_by_author[0].tag[0].label).toBe("orm");
      const root = await db.category.create({ data: { name: "root" } });
      await db.category.create({
        data: { name: "child", parent_id: root.id },
      });
      const tree = await db.category.findUnique({
        where: { id: root.id },
        include: { category_by_parent: true },
      });
      expect(
        tree.category_by_parent.map((c: { name: string }) => c.name)
      ).toEqual(["child"]);
    });

    it("as a light document: no index, reads and writes, refused by push", async () => {
      const driver = await estate.fresh();
      await run(driver, [
        ...RICH_POSTGRES_SQL,
        ...RICH_SKIPPED_SQL,
        'ALTER TABLE tag ALTER COLUMN label TYPE varchar(64) COLLATE "C"',
      ]);
      const tables = [...RICH_TABLES, "ledger"];
      const { full, light, client } = await expectLightDocument(driver, tables);
      // What only a migration reads: the indexes, the CHECK, the collation.
      expect(full.document.models.post!.indexes).toHaveLength(3);
      expect(full.skipped.map(({ kind, name }) => `${kind} ${name}`)).toContain(
        "check account_email_shape"
      );
      expect(full.warnings).toContainEqual({
        kind: "unstated",
        table: "tag",
        message:
          'the document cannot carry a collation on column "label": the database keeps it and a push of the document plans nothing for it, but a push that recreates the table or the column cannot keep it',
      });
      expect(light.document.models.post!.indexes).toBeUndefined();
      expect(
        light.skipped.map(({ kind, name }) => `${kind} ${name}`).sort()
      ).toEqual(["table ledger", "view account_emails"]);
      expect(light.warnings).toEqual([]);
      // What a client reads stays: keys, uniques, defaults, native types.
      expect(light.document.models.account!.fields.email).toEqual({
        type: "string",
        native: { db: "pg", type: "varchar(320)" },
        unique: true,
      });
      expect(light.document.models.post!.uniques).toEqual([
        { fields: ["author_id", "slug"] },
      ]);

      const db = client as any;
      const author = await db.account.create({
        data: { email: "ada@example.com" },
      });
      expect(author.role).toBe("member");
      const tag = await db.tag.create({ data: { label: "orm" } });
      await db.post.create({
        data: {
          slug: "hello",
          title: "Hello",
          author: { connect: { id: author.id } },
          tag: { connect: [{ id: tag.id }] },
        },
      });
      const found = await db.account.findUnique({
        where: { email: "ada@example.com" },
        include: { post_by_author: { include: { tag: true } } },
      });
      expect(found.post_by_author[0].tag[0].label).toBe("orm");
    });

    it("lists what it cannot state, and still round-trips the rest", async () => {
      const driver = await estate.fresh();
      await run(driver, [...RICH_POSTGRES_SQL, ...RICH_SKIPPED_SQL]);
      const result = await introspectSchema({ driver });
      const skipped = result.skipped.map((item) => [
        item.kind,
        item.table ?? "",
        item.name,
      ]);
      expect(skipped).toEqual(
        expect.arrayContaining([
          ["table", "", "audit_log"],
          ["view", "", "account_emails"],
          ["table", "", "ledger"],
          ["check", "account", "account_email_shape"],
        ])
      );
      expect(
        result.skipped.find((item) => item.name === "ledger")?.reason
      ).toContain("generated");
      expect(Object.keys(result.document.models)).not.toContain("audit_log");
      // The rest is exact.
      expect(
        result.warnings.filter((warning) => warning.kind === "drift")
      ).toEqual([]);
    });
  });

  it("reports, as drift, what a document states exactly but push would still change", async () => {
    const driver = await estate.fresh();
    await run(driver, [
      "CREATE TABLE owner (id integer PRIMARY KEY)",
      "CREATE TABLE pet (id integer PRIMARY KEY, owner_id integer NOT NULL, born timestamptz NOT NULL DEFAULT now(), CONSTRAINT fk_pet_owner FOREIGN KEY (owner_id) REFERENCES owner(id))",
    ]);
    const result = await introspectSchema({ driver });
    expect(result.document.models.pet!.fields.owner).toMatchObject({
      type: "toOne",
      target: "owner",
    });
    expect(
      result.warnings.map((warning) => [
        warning.kind,
        warning.table,
        warning.name,
      ])
    ).toEqual([
      ["drift", "pet", "fk_pet_owner"],
      ["drift", "pet", "born"],
      ["drift", "pet", "pet_owner_id_idx"],
    ]);
    expect(result.warnings[0]!.message).toContain('"pet_owner_id_fkey"');
    expect(result.warnings[1]!.message).toContain("date_trunc('milliseconds'");
  });

  describe("a database VibORM pushed", () => {
    it("finds the schema again: same tables, same relations, an empty plan", async () => {
      const driver = await estate.fresh();
      const original = codedSchema();
      const pusher = createClient({ schema: original, driver });
      const migrations = createMigrationClient(pusher);
      await migrations.push({
        consent: (await migrations.push({ dryRun: true })).consent,
      });
      const tables = ["members", "article", "topic", "article_topic"];
      const { result } = await expectEmptyRoundTrip(driver, tables);

      // Physically the same schema, both ways.
      const migrationDriver = getMigrationDriver(driver);
      const fromDocument = serializeModels(parseSchema(result.document), {
        migrationDriver,
      });
      const fromCode = serializeModels(codedSchema(), { migrationDriver });
      expect((await diff(fromCode, fromDocument)).operations).toEqual([]);
      expect((await diff(fromDocument, fromCode)).operations).toEqual([]);

      // The relations are found again: the same pairs, the many-to-many as a
      // generated junction.
      const { models } = result.document;
      expect(Object.keys(models).sort()).toEqual([
        "article",
        "members",
        "topic",
      ]);
      expect(models.article!.fields.author).toMatchObject({
        type: "toOne",
        target: "members",
        fields: ["authorId"],
        references: ["id"],
        onDelete: "cascade",
      });
      expect(models.members!.fields.mentor).toMatchObject({
        type: "toOne",
        target: "members",
        fields: ["mentorId"],
        onDelete: "setNull",
      });
      expect(models.article!.fields.topic).toMatchObject({
        type: "toMany",
        target: "topic",
        junction: { table: "article_topic" },
      });
      expect(models.members!.fields.role).toMatchObject({
        type: "enum",
        enum: "member_role",
      });
      expect(serializeSchema(parseSchema(result.document))).toEqual(
        result.document
      );
    });
  });
}
