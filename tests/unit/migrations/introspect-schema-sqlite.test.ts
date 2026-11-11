/**
 * `introspectSchema` on SQLite (better-sqlite3): a hand-written database round
 * trips to an empty push plan, a database VibORM pushed is found again, and
 * the `file:` entry opens the file read-only and closes it.
 *
 * SQLite proves less than PostgreSQL: a column's declared type is free text,
 * a DateTime is TEXT, a boolean INTEGER, a list JSON and a uuid key a BLOB. What
 * the catalog cannot prove is read as the storage it is, and said.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { createPullCommand } from "@src/cli/commands/pull";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  codedSchema,
  expectEmptyRoundTrip,
  expectLightDocument,
} from "./_introspect-fixtures";

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

  it("says what a table carries beyond the document: a collation, STRICT, ON CONFLICT, a trigger", async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, code TEXT NOT NULL ON CONFLICT REPLACE)"
    );
    db.exec(
      "CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER) STRICT"
    );
    db.exec(
      "CREATE TRIGGER ledger_audit AFTER INSERT ON ledger BEGIN SELECT 1; END"
    );
    const result = await introspectSchema({
      driver: new SQLite3Driver({ client: db }),
    });
    const lost = (feature: string) =>
      `the document cannot carry ${feature}: the database keeps it and a push of the document plans nothing for it, but a push that recreates the table or the column cannot keep it`;
    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([
      { kind: "unstated", table: "ledger", message: lost("STRICT") },
      {
        kind: "unstated",
        table: "ledger",
        message: lost('trigger "ledger_audit"'),
      },
      {
        kind: "unstated",
        table: "person",
        message: lost('a collation on column "name"'),
      },
      {
        kind: "unstated",
        table: "person",
        message: lost('ON CONFLICT on column "code"'),
      },
    ]);
    // Nothing here is a drift: the push of the document plans nothing.
    const client = createClient({
      schema: parseSchema(result.document),
      driver: new SQLite3Driver({ client: db }),
    });
    const preview = await createMigrationClient(client).push({ dryRun: true });
    expect(preview.operations).toEqual([]);
  });

  it("declares NOT NULL a key column SQLite lets hold NULL, says so, and push rebuilds the table", async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE token (id TEXT PRIMARY KEY, value TEXT COLLATE NOCASE)"
    );
    db.exec("CREATE TABLE pair (a TEXT, b INTEGER, PRIMARY KEY (a, b))");
    const driver = new SQLite3Driver({ client: db });
    const result = await introspectSchema({ driver });
    const { models } = result.document;
    expect(models.token!.fields.id).toEqual({
      type: "string",
      id: true,
      generate: { kind: "ulid", generate: false, implicit: true },
    });
    expect(models.pair!.fields).toMatchObject({
      a: { type: "string" },
      b: { type: "int" },
    });
    expect(models.pair!.fields.a!).not.toHaveProperty("nullable");
    expect(models.pair!.fields.b!).not.toHaveProperty("nullable");
    expect(
      result.warnings.map(
        ({ kind, table, name }) => `${kind} ${table}.${name ?? ""}`
      )
    ).toEqual([
      "approximated pair.a",
      "approximated pair.b",
      "approximated token.id",
      "unstated token.",
      "drift pair.a",
      "drift pair.b",
      "drift token.id",
    ]);
    expect(result.warnings[0]!.message).toContain(
      "a push of the document rebuilds the table to make it NOT NULL"
    );
    // The schema is valid, and push plans a rebuild of each table.
    const client = createClient({
      schema: parseSchema(result.document, { validate: true }),
      driver,
    });
    const preview = await createMigrationClient(client).push({ dryRun: true });
    expect(preview.operations).toEqual([
      expect.objectContaining({ id: "alterColumn:0", risk: "destructive" }),
      expect.objectContaining({ id: "alterColumn:1", risk: "destructive" }),
      expect.objectContaining({ id: "alterColumn:2", risk: "destructive" }),
    ]);
    expect(preview.statements.map(({ sql }) => sql)).toContain(
      'CREATE TABLE "__new_token" (\n  "id" TEXT NOT NULL,\n  "value" TEXT,\n  PRIMARY KEY ("id")\n)'
    );
  });

  it("as a light document: no index, reads and writes, refused by push", async () => {
    const db = richDatabase();
    db.exec(
      "CREATE TABLE token (id TEXT PRIMARY KEY, value TEXT COLLATE NOCASE)"
    );
    const driver = new SQLite3Driver({ client: db });
    const { full, light, client } = await expectLightDocument(driver, [
      ...RICH_TABLES,
      "token",
    ]);
    expect(full.document.models.post!.indexes).toHaveLength(2);
    expect(light.document.models.post!.indexes).toBeUndefined();
    // What matters to a client stays: a key that may hold NULL. A collation,
    // which only a push could lose, does not.
    expect(full.warnings.map(({ kind, table }) => `${kind} ${table}`)).toEqual([
      "approximated token",
      "unstated token",
      "drift token",
    ]);
    expect(
      light.warnings.map(({ kind, table, name }) => `${kind} ${table}.${name}`)
    ).toEqual(["approximated token.id"]);
    expect(light.document.models.post!.uniques).toEqual([
      { fields: ["author_id", "title"] },
    ]);
    expect(light.document.models.account!.fields.created_at).toEqual({
      type: "datetime",
      generate: { kind: "now" },
    });

    const app = client as any;
    const author = await app.account.create({
      data: { email: "ada@example.com" },
    });
    expect(author.role).toBe("member");
    const tag = await app.tag.create({ data: { id: 1, label: "orm" } });
    await app.post.create({
      data: {
        title: "Hello",
        author: { connect: { id: author.id } },
        tag: { connect: [{ id: tag.id }] },
      },
    });
    const found = await app.account.findUnique({
      where: { email: "ada@example.com" },
      include: { post_by_author: { include: { tag: true } } },
    });
    expect(found.post_by_author[0].tag[0].label).toBe("orm");
    await app.token.create({ data: { id: "t1", value: "Alice" } });
    expect(await app.token.findUnique({ where: { id: "t1" } })).toEqual({
      id: "t1",
      value: "Alice",
    });
  });

  it("viborm pull --json --light writes a light document", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-pull-light-"));
    directories.push(directory);
    const path = join(directory, "app.db");
    const db = new Database(path);
    for (const statement of RICH_SQLITE_SQL) db.exec(statement);
    db.close();
    const out = join(directory, "schema.json");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await createPullCommand().parseAsync(
        ["--json", "--light", "--url", `file:${path}`, "--out", out],
        { from: "user" }
      );
    } finally {
      stderr.mockRestore();
    }
    const document = JSON.parse(readFileSync(out, "utf8"));
    expect(document.light).toBe(true);
    expect(document.models.post.indexes).toBeUndefined();
    expect(document).toEqual(
      (await introspectSchema({ url: `file:${path}`, light: true })).document
    );
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
