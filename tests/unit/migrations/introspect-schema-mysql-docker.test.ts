/**
 * `introspectSchema` on a real MySQL server: a hand-written database round
 * trips to an empty push plan and serves relation queries, a database VibORM
 * pushed is found again, and the `mysql://` entry closes its connection.
 *
 * MySQL has no standalone enum (an `ENUM(…)` is its column's type, inline) and
 * one unique namespace (a unique constraint is a unique index). A uuid key is
 * `BINARY(16)`: read back as the uuid key, and said.
 *
 * Run locally with:
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { createMigrationClient } from "@migrations";
import { diff } from "@migrations/differ";
import { getMigrationDriver } from "@migrations/drivers";
import { introspectSchema } from "@migrations/introspect";
import { serializeModels } from "@migrations/serializer";
import { parseSchema } from "@schema/json";
import { afterAll, describe, expect, it } from "vitest";
import { codedSchema, expectEmptyRoundTrip } from "./_introspect-fixtures";

const CONNECTION_STRING = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIfDocker = CONNECTION_STRING ? describe : describe.skip;

const RICH_MYSQL_SQL = [
  `CREATE TABLE account (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(191) NOT NULL,
    role ENUM('owner', 'admin', 'member') NOT NULL DEFAULT 'member',
    display_name TEXT,
    country CHAR(2) NOT NULL DEFAULT 'FR',
    balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    score DOUBLE,
    ratio FLOAT,
    visits INT NOT NULL DEFAULT 0,
    big_counter BIGINT NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    settings JSON,
    avatar BLOB,
    bio LONGTEXT,
    birthday DATE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY account_email_key (email)
  )`,
  `CREATE TABLE profile (
    account_id INT PRIMARY KEY,
    headline VARCHAR(120) NOT NULL DEFAULT '',
    CONSTRAINT profile_account_id_fkey FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE category (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    parent_id INT NULL,
    UNIQUE KEY category_parent_id_name_key (parent_id, name),
    CONSTRAINT category_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES category(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE post (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    author_id INT NOT NULL,
    reviewer_id INT NULL,
    category_id INT NULL,
    slug VARCHAR(191) NOT NULL,
    title VARCHAR(200) NOT NULL,
    published_at DATETIME(3) NULL,
    UNIQUE KEY post_author_id_slug_key (author_id, slug),
    KEY post_reviewer_id_idx (reviewer_id),
    KEY post_category_id_idx (category_id),
    CONSTRAINT post_author_id_fkey FOREIGN KEY (author_id) REFERENCES account(id) ON DELETE CASCADE,
    CONSTRAINT post_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES account(id) ON DELETE SET NULL,
    CONSTRAINT post_category_id_fkey FOREIGN KEY (category_id) REFERENCES category(id)
  )`,
  `CREATE TABLE tag (
    id INT AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(191) NOT NULL,
    UNIQUE KEY tag_label_key (label)
  )`,
  `CREATE TABLE post_tag (
    post_id BIGINT NOT NULL,
    tag_id INT NOT NULL,
    PRIMARY KEY (post_id, tag_id),
    KEY post_tag_tag_id_idx (tag_id),
    CONSTRAINT post_tag_post_id_fkey FOREIGN KEY (post_id) REFERENCES post(id) ON DELETE CASCADE,
    CONSTRAINT post_tag_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES tag(id) ON DELETE CASCADE
  )`,
];
const RICH_TABLES = [
  "account",
  "profile",
  "category",
  "post",
  "tag",
  "post_tag",
];

const created: string[] = [];

function urlFor(database: string): string {
  const url = new URL(CONNECTION_STRING!);
  url.pathname = `/${database}`;
  return url.href;
}

async function freshDatabase(): Promise<MySQL2Driver> {
  const name = `viborm_introspect_${process.pid}_${created.length}`;
  const admin = new MySQL2Driver({ databaseUrl: CONNECTION_STRING });
  try {
    await admin._executeRaw(`DROP DATABASE IF EXISTS \`${name}\``, []);
    await admin._executeRaw(`CREATE DATABASE \`${name}\``, []);
  } finally {
    await admin.disconnect();
  }
  created.push(name);
  return new MySQL2Driver({
    databaseUrl: urlFor(name),
    migrationNamespaceAttestation: "non-redirecting",
  });
}

describeIfDocker("introspectSchema on MySQL (docker)", () => {
  const opened: MySQL2Driver[] = [];
  afterAll(async () => {
    for (const driver of opened) await driver.disconnect();
    const admin = new MySQL2Driver({ databaseUrl: CONNECTION_STRING });
    try {
      for (const name of created)
        await admin._executeRaw(`DROP DATABASE IF EXISTS \`${name}\``, []);
    } finally {
      await admin.disconnect();
    }
  });

  it("round-trips a hand-written database to an EMPTY push plan, and serves relation queries", async () => {
    const driver = await freshDatabase();
    opened.push(driver);
    for (const statement of RICH_MYSQL_SQL)
      await driver._executeRaw(statement, []);
    const { result, client } = await expectEmptyRoundTrip(driver, RICH_TABLES);
    const { models } = result.document;
    expect(Object.keys(models).sort()).toEqual([
      "account",
      "category",
      "post",
      "profile",
      "tag",
    ]);
    expect(models.account!.fields).toMatchObject({
      email: { type: "string", unique: true },
      role: {
        type: "enum",
        enum: ["owner", "admin", "member"],
        default: "member",
      },
      country: { type: "string", native: { db: "mysql", type: "CHAR(2)" } },
      balance: { type: "decimal", precision: 12, scale: 2 },
      active: { type: "boolean", default: true },
      created_at: { type: "datetime", generate: { kind: "now" } },
      post_by_author: { type: "toMany", target: "post" },
      profile: { type: "toOne", target: "profile" },
    });
    expect(models.post!.fields.author).toMatchObject({
      type: "toOne",
      target: "account",
      onDelete: "cascade",
      name: "post_author_id_fkey",
    });
    expect(models.post!.uniques).toEqual([{ fields: ["author_id", "slug"] }]);
    expect(models.post!.fields.tag).toMatchObject({
      type: "toMany",
      target: "tag",
    });
    expect(result.warnings).toEqual([]);

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
    const found = await db.account.findMany({
      include: { post_by_author: { include: { tag: true } } },
    });
    expect(found[0].post_by_author[0].tag[0].label).toBe("orm");
    const byEmail = await db.account.findUnique({
      where: { email: "ada@example.com" },
    });
    expect(byEmail.id).toBe(author.id);
  });

  it("finds a database VibORM pushed: same tables, same relations, an empty plan", async () => {
    const driver = await freshDatabase();
    opened.push(driver);
    const pusher = createClient({ schema: codedSchema(), driver });
    const migrations = createMigrationClient(pusher);
    await migrations.push({
      consent: (await migrations.push({ dryRun: true })).consent,
    });
    const { result } = await expectEmptyRoundTrip(driver, [
      "members",
      "article",
      "topic",
      "article_topic",
    ]);
    const migrationDriver = getMigrationDriver(driver);
    const fromDocument = serializeModels(parseSchema(result.document), {
      migrationDriver,
    });
    const fromCode = serializeModels(codedSchema(), { migrationDriver });
    expect((await diff(fromCode, fromDocument)).operations).toEqual([]);
    expect((await diff(fromDocument, fromCode)).operations).toEqual([]);
    const { models } = result.document;
    expect(models.members!.fields).toMatchObject({
      email: { type: "string", unique: true },
      role: { type: "enum", enum: ["owner", "member"] },
      active: { type: "boolean", default: true },
      createdAt: { type: "datetime", generate: { kind: "now" } },
      mentor: { type: "toOne", target: "members", onDelete: "setNull" },
    });
    expect(models.article!.fields.topic).toMatchObject({
      type: "toMany",
      junction: { table: "article_topic" },
    });
    expect(
      result.warnings
        .map((warning) => `${warning.kind} ${warning.table}.${warning.name}`)
        .sort()
    ).toEqual([
      "approximated article.authorId",
      "approximated article.editorId",
      "approximated members.id",
      "approximated members.mentorId",
    ]);
  });

  it("reads a mysql:// URL, closes it, and reports views and CHECK constraints", async () => {
    const driver = await freshDatabase();
    for (const statement of [
      ...RICH_MYSQL_SQL,
      "CREATE VIEW account_emails AS SELECT id, email FROM account",
      "CREATE TABLE events (at DATETIME(3), message TEXT)",
      "ALTER TABLE account ADD CONSTRAINT account_visits_positive CHECK (visits >= 0)",
    ])
      await driver._executeRaw(statement, []);
    await driver.disconnect();
    const name = created.at(-1)!;
    const result = await introspectSchema({ url: urlFor(name) });
    expect(result.dialect).toBe("mysql");
    expect(result.skipped.map((item) => [item.kind, item.name])).toEqual(
      expect.arrayContaining([
        ["view", "account_emails"],
        ["table", "events"],
        ["check", "account_visits_positive"],
      ])
    );
    const probe = new MySQL2Driver({ databaseUrl: CONNECTION_STRING });
    try {
      const sessions = await probe._executeRaw<{ count: number | string }>(
        "SELECT COUNT(*) AS count FROM information_schema.PROCESSLIST WHERE DB = ?",
        [name]
      );
      expect(Number(sessions.rows[0]?.count)).toBe(0);
    } finally {
      await probe.disconnect();
    }
  });
});
