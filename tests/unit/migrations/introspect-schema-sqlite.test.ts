/**
 * `introspectSchema` on SQLite (better-sqlite3): a hand-written database round
 * trips to an empty push plan, a database VibORM pushed is found again, and
 * the `file:` entry opens the file read-only and closes it.
 *
 * SQLite proves less than PostgreSQL: a column's declared type is free text,
 * a DateTime is TEXT, a boolean INTEGER, a list JSON and a uuid key a BLOB. What
 * the catalog cannot prove is read as the storage it is, and said.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createMigrationClient } from "@migrations";
import { diff } from "@migrations/differ";
import { getMigrationDriver } from "@migrations/drivers";
import { introspectSchema } from "@migrations/introspect";
import { serializeModels } from "@migrations/serializer";
import { parseSchema } from "@schema/json";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { codedSchema, expectEmptyRoundTrip } from "./_introspect-fixtures";

const RICH_SQLITE_SQL = [
  `CREATE TABLE account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    role TEXT CHECK("role" IN ('owner', 'member')) NOT NULL DEFAULT 'member',
    display_name TEXT,
    score REAL DEFAULT 1.5,
    visits INTEGER NOT NULL DEFAULT 0,
    avatar BLOB,
    settings JSON,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE TABLE profile (
    account_id INTEGER PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
    bio TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE category (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES category(id) ON DELETE SET NULL,
    UNIQUE (parent_id, name)
  )`,
  `CREATE TABLE post (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL REFERENCES account(id) ON DELETE CASCADE,
    reviewer_id INTEGER REFERENCES account(id) ON DELETE SET NULL,
    category_id INTEGER REFERENCES category(id),
    title TEXT NOT NULL,
    UNIQUE (author_id, title)
  )`,
  "CREATE INDEX post_reviewer_id_idx ON post (reviewer_id)",
  "CREATE INDEX post_category_id_idx ON post (category_id)",
  `CREATE TABLE tag (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE post_tag (
    post_id INTEGER NOT NULL REFERENCES post(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, tag_id)
  )`,
  "CREATE INDEX post_tag_tag_id_idx ON post_tag (tag_id)",
];
const RICH_TABLES = [
  "account",
  "profile",
  "category",
  "post",
  "tag",
  "post_tag",
];

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

function richDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const statement of RICH_SQLITE_SQL) db.exec(statement);
  return db;
}

describe("introspectSchema on SQLite", () => {
  it("round-trips a hand-written database to an EMPTY push plan, and serves relation queries", async () => {
    const driver = new SQLite3Driver({ client: richDatabase() });
    const { result, client } = await expectEmptyRoundTrip(driver, RICH_TABLES);
    const { models } = result.document;
    expect(Object.keys(models).sort()).toEqual([
      "account",
      "category",
      "post",
      "profile",
      "tag",
    ]);
    expect(models.post!.fields.author).toMatchObject({
      type: "toOne",
      target: "account",
      fields: ["author_id"],
      references: ["id"],
      onDelete: "cascade",
    });
    expect(models.account!.fields.role).toEqual({
      type: "enum",
      enum: ["owner", "member"],
      default: "member",
    });
    expect(models.account!.fields.created_at).toEqual({
      type: "datetime",
      generate: { kind: "now" },
    });
    expect(models.account!.fields.profile).toEqual({
      type: "toOne",
      target: "profile",
    });
    expect(models.post!.fields.tag).toMatchObject({
      type: "toMany",
      target: "tag",
    });
    expect(result.warnings).toEqual([]);

    const db = client as any;
    const author = await db.account.create({
      data: { email: "ada@example.com" },
    });
    expect(author.created_at).toBeInstanceOf(Date);
    const tag = await db.tag.create({ data: { id: 1, label: "orm" } });
    await db.post.create({
      data: {
        title: "Hello",
        author: { connect: { id: author.id } },
        tag: { connect: [{ id: tag.id }] },
      },
    });
    const found = await db.account.findMany({
      include: { post_by_author: { include: { tag: true } } },
    });
    expect(found[0].post_by_author[0].tag[0].label).toBe("orm");
  });

  it("keeps a WITHOUT ROWID table's clustering, to an EMPTY push plan", async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE setting (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key)) WITHOUT ROWID"
    );
    const driver = new SQLite3Driver({ client: db });
    const { result } = await expectEmptyRoundTrip(driver, ["setting"]);
    expect(result.document.models.setting).toMatchObject({
      ids: [{ fields: ["scope", "key"] }],
      withoutRowid: true,
    });
    expect(result.warnings).toEqual([]);
  });

  it("finds a database VibORM pushed, with the facts SQLite cannot prove said", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
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
    expect(
      (await diff(fromCode, fromDocument, { matchConstraintsByShape: true }))
        .operations
    ).toEqual([]);
    expect(
      (await diff(fromDocument, fromCode, { matchConstraintsByShape: true }))
        .operations
    ).toEqual([]);
    const { models } = result.document;
    expect(models.members!.fields.createdAt).toEqual({
      type: "datetime",
      generate: { kind: "now" },
    });
    expect(models.members!.fields.balance).toMatchObject({
      type: "decimal",
      precision: 10,
      scale: 2,
    });
    expect(models.topic!.fields.article).toMatchObject({
      type: "toMany",
      target: "article",
      junction: { table: "article_topic" },
    });
    // A uuid key is a BLOB on SQLite: read back as the uuid key, and said.
    expect(models.members!.fields.id).toMatchObject({
      type: "string",
      id: true,
      generate: { kind: "uuid", generate: false },
    });
    expect(
      result.warnings
        .filter((warning) => warning.kind === "approximated")
        .map((warning) => `${warning.table}.${warning.name}`)
        .sort()
    ).toEqual([
      "article.authorId",
      "article.editorId",
      "members.id",
      "members.mentorId",
    ]);
  });

  it("opens a file: URL read-only, closes it, and reports views and keyless tables", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-introspect-"));
    directories.push(directory);
    const path = join(directory, "app.db");
    const db = new Database(path);
    for (const statement of RICH_SQLITE_SQL) db.exec(statement);
    db.exec("CREATE TABLE events (at TEXT, payload TEXT)");
    db.exec("CREATE VIEW account_emails AS SELECT id, email FROM account");
    db.close();

    const result = await introspectSchema({ url: `file:${path}` });
    expect(result.dialect).toBe("sqlite");
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "table", name: "events" }),
        expect.objectContaining({ kind: "view", name: "account_emails" }),
      ])
    );
    expect(Object.keys(result.document.models)).not.toContain("events");
    // Closed: the file can be opened for writing and removed.
    const again = new Database(path);
    again.exec("DROP VIEW account_emails");
    again.close();
    await expect(
      introspectSchema({ url: `file:${join(directory, "missing.db")}` })
    ).rejects.toThrow();
  });

  it("refuses, by name, a database it does not translate yet", async () => {
    await expect(
      introspectSchema({ url: "surrealdb://127.0.0.1:8000" })
    ).rejects.toThrow("does not translate SurrealDB yet");
    await expect(
      introspectSchema({ url: "redis://127.0.0.1" })
    ).rejects.toThrow("cannot tell which database");
  });
});
