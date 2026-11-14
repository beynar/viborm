/**
 * `introspectSchema` on a real SQL Server: a hand-written schema becomes a
 * document whose models serialize back to exactly what the catalog holds (no
 * drift), serves relation queries, and reports what it cannot carry.
 *
 * VibORM writes no SQL Server DDL, so the round trip is checked by the
 * differ itself, not by a push. Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import { diff } from "@migrations/differ";
import { getMigrationDriver } from "@migrations/drivers";
import { introspectSchema } from "@migrations/introspect";
import { serializeModels } from "@migrations/serializer";
import { parseSchema, serializeSchema } from "@schema/json";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropSchema, TEST_CONNECTION_STRING } from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const SCHEMA = "introspect_doc";
const TRIGGER_WARNING = /^tag: .*trigger "tag_touch"/;
const COLLATION_WARNING =
  /^account: .*Latin1_General_100_BIN2 on column "handle"/;
const TABLES = ["account", "post", "tag", "post_tag"];

const SETUP = [
  `IF SCHEMA_ID('${SCHEMA}') IS NULL EXEC('CREATE SCHEMA ${SCHEMA}')`,
  ...["post_tag", "post", "tag", "account"].map(
    (table) =>
      `IF OBJECT_ID('${SCHEMA}.${table}') IS NOT NULL DROP TABLE ${SCHEMA}.${table}`
  ),
  `IF OBJECT_ID('${SCHEMA}.account_names') IS NOT NULL DROP VIEW ${SCHEMA}.account_names`,
  `CREATE TABLE ${SCHEMA}.account (
    id INT IDENTITY(1,1) NOT NULL CONSTRAINT account_pkey PRIMARY KEY,
    email NVARCHAR(450) NOT NULL CONSTRAINT account_email_key UNIQUE,
    display_name NVARCHAR(MAX) NULL,
    country NVARCHAR(2) NOT NULL DEFAULT N'FR',
    balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    score FLOAT NULL,
    visits INT NOT NULL DEFAULT 0,
    big_counter BIGINT NOT NULL DEFAULT 0,
    active BIT NOT NULL DEFAULT 1,
    avatar VARBINARY(MAX) NULL,
    handle NVARCHAR(MAX) COLLATE Latin1_General_100_BIN2 NULL,
    birthday DATE NULL,
    created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT account_visits_check CHECK (visits >= 0)
  )`,
  `CREATE TABLE ${SCHEMA}.post (
    id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT post_pkey PRIMARY KEY,
    author_id INT NOT NULL CONSTRAINT post_author_id_fkey FOREIGN KEY REFERENCES ${SCHEMA}.account(id) ON DELETE CASCADE,
    slug NVARCHAR(450) NOT NULL,
    title NVARCHAR(MAX) NOT NULL,
    CONSTRAINT post_author_id_slug_key UNIQUE (author_id, slug)
  )`,
  `CREATE TABLE ${SCHEMA}.tag (
    id INT IDENTITY(1,1) NOT NULL CONSTRAINT tag_pkey PRIMARY KEY,
    label NVARCHAR(450) NOT NULL CONSTRAINT tag_label_key UNIQUE
  )`,
  `CREATE TABLE ${SCHEMA}.post_tag (
    post_id BIGINT NOT NULL CONSTRAINT post_tag_post_id_fkey FOREIGN KEY REFERENCES ${SCHEMA}.post(id) ON DELETE CASCADE,
    tag_id INT NOT NULL CONSTRAINT post_tag_tag_id_fkey FOREIGN KEY REFERENCES ${SCHEMA}.tag(id) ON DELETE CASCADE,
    CONSTRAINT post_tag_pkey PRIMARY KEY (post_id, tag_id)
  )`,
  `CREATE INDEX post_tag_tag_id_idx ON ${SCHEMA}.post_tag (tag_id)`,
  `CREATE VIEW ${SCHEMA}.account_names AS SELECT id, email FROM ${SCHEMA}.account`,
  `CREATE TRIGGER ${SCHEMA}.tag_touch ON ${SCHEMA}.tag AFTER INSERT AS SET NOCOUNT ON`,
];

describeIf("introspectSchema on SQL Server", () => {
  const driver = new MssqlDriver({
    databaseUrl: TEST_CONNECTION_STRING,
    namespace: SCHEMA,
  });

  beforeAll(async () => {
    for (const statement of SETUP) await driver._executeRaw(statement, []);
  });
  afterAll(async () => {
    await driver.disconnect();
    await dropSchema(SCHEMA);
  });

  it("reads a hand-written schema into a document with no drift", async () => {
    const result = await introspectSchema({ driver, tables: TABLES });
    expect(result.dialect).toBe("mssql");
    // NVARCHAR(2) is spelled by its SQL Server native type: no drift.
    expect(
      result.warnings
        .filter(({ kind }) => kind === "drift")
        .map(({ table, name }) => `${table}.${name}`)
    ).toEqual([]);
    const { models } = result.document;
    expect(Object.keys(models).sort()).toEqual(["account", "post", "tag"]);
    expect(models.account!.fields).toMatchObject({
      id: { type: "int", generate: { kind: "increment" } },
      email: { type: "string", unique: true },
      display_name: { type: "string", nullable: true },
      country: { type: "string", default: "FR" },
      balance: { type: "decimal", precision: 12, scale: 2 },
      score: { type: "number", nullable: true },
      big_counter: { type: "bigint" },
      active: { type: "boolean", default: true },
      avatar: { type: "blob", nullable: true },
      birthday: { type: "date", nullable: true },
      created_at: { type: "datetime", generate: { kind: "now" } },
    });
    expect(models.post!.fields.author).toMatchObject({
      type: "toOne",
      target: "account",
      onDelete: "cascade",
    });
    expect(models.post!.fields.tag).toMatchObject({
      type: "toMany",
      target: "tag",
    });
    // The document is already canonical.
    expect(serializeSchema(parseSchema(result.document))).toEqual(
      result.document
    );

    // The differ finds nothing between the document and the catalog.
    const migrationDriver = getMigrationDriver(driver, TABLES);
    const live = await migrationDriver.introspect((sql, params) =>
      driver._executeRaw(sql, params)
    );
    const fromDocument = serializeModels(parseSchema(result.document), {
      migrationDriver,
    });
    expect(
      (await diff(live, fromDocument)).operations.map(
        (operation) => operation.type
      )
    ).toEqual([]);
    expect(JSON.stringify(models.account!.fields.country)).toContain(
      "NVARCHAR(2)"
    );
  });

  it("says what the document cannot carry", async () => {
    const result = await introspectSchema({ driver });
    expect(result.skipped).toContainEqual({
      kind: "view",
      name: "account_names",
      reason: "it is a view, and a document declares tables only",
    });
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        kind: "check",
        table: "account",
        name: "account_visits_check",
      })
    );
    const unstated = result.warnings
      .filter(({ kind }) => kind === "unstated")
      .map(({ table, message }) => `${table}: ${message}`);
    expect(unstated).toContainEqual(expect.stringMatching(TRIGGER_WARNING));
    expect(unstated).toContainEqual(expect.stringMatching(COLLATION_WARNING));
    // A sized text column keeps its native type: nothing approximated.
    expect(
      result.warnings.filter(
        ({ kind, name }) => kind === "approximated" && name === "country"
      )
    ).toEqual([]);
  });

  it("serves reads and writes through the document", async () => {
    const result = await introspectSchema({ driver, tables: TABLES });
    const db = createClient({
      schema: parseSchema(result.document, { validate: true }),
      driver,
    }) as any;
    const author = await db.account.create({
      data: { email: "ada@example.com" },
    });
    expect(author).toMatchObject({ country: "FR", active: true, visits: 0 });
    const tag = await db.tag.create({ data: { label: "orm" } });
    await db.post.create({
      data: {
        slug: "hello",
        title: "Hello",
        author: { connect: { id: author.id } },
        tag: { connect: [{ id: tag.id }] },
      },
    });
    const posts = Object.entries(result.document.models.account!.fields).find(
      ([, field]) => field.type === "toMany"
    )![0];
    const found = await db.account.findMany({
      where: { email: "ada@example.com" },
      include: { [posts]: { include: { tag: true } } },
    });
    expect(found[0][posts][0].tag[0].label).toBe("orm");
  });

  it("reads a light document: the same models without their indexes", async () => {
    const full = await introspectSchema({ driver, tables: TABLES });
    const light = await introspectSchema({
      driver,
      tables: TABLES,
      light: true,
    });
    expect(light.document.light).toBe(true);
    for (const [key, { indexes: _indexes, ...model }] of Object.entries(
      full.document.models
    ))
      expect(light.document.models[key]).toEqual(model);
  });

  it("opens a SQL Server driver from an mssql:// URL", async () => {
    const result = await introspectSchema({ url: TEST_CONNECTION_STRING! });
    expect(result.dialect).toBe("mssql");
  });
});
