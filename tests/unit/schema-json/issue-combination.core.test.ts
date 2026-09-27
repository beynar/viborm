/**
 * Issues #45, #46 and #47 on ONE schema (`tests/fixtures/issue-combination.ts`):
 * native-type maps, an insert-only `.now()` timestamp and an asymmetric
 * junction, owned by three different declarations, must survive the same
 * document, the same snapshot and the same diff together.
 *
 *   · Combined falsifier 1 — the schema-JSON round trip preserves all three.
 *   · Combined falsifier 2 — the junction's key columns inherit each dialect's
 *     storage from the keys they reference, and the unrelated creation
 *     timestamp still refuses every update path.
 *   · Combined falsifier 4 (snapshot half) — changing only the junction policy,
 *     or only the active dialect's native entry, plans exactly that change;
 *     another dialect's entry and a pure respelling plan nothing. The live half
 *     (push, second push) is `issue-combination-behavior.ts`.
 */

import { validateOperationPayload } from "@client/schema-introspection";
import { ValidationError } from "@errors";
import type { Schema } from "@schema/hydration";
import { parseSchema, serializeSchema } from "@schema/json";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import { diff } from "@src/migrations/differ";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import { hydrateSchemaNames } from "@src/schema/hydration";
import {
  CREATED_STORAGE,
  combinationSchema,
  JUNCTION_TABLE,
  TITLE_STORAGE,
} from "@tests/fixtures/issue-combination";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, it } from "vitest";

const DIALECTS = {
  postgres: postgresMigrationDriver,
  mysql: mysqlMigrationDriver,
  sqlite: sqlite3MigrationDriver,
} as const;
type Dialect = keyof typeof DIALECTS;
const EACH_DIALECT = Object.keys(DIALECTS) as Dialect[];

const LATER = "2026-02-01T00:00:00.000Z";
const POST_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

function snapshotOf(schema: Schema, dialect: Dialect) {
  hydrateSchemaNames(schema);
  return serializeModels(schema, { migrationDriver: DIALECTS[dialect] });
}

function tableOf(schema: Schema, dialect: Dialect, name: string) {
  const table = snapshotOf(schema, dialect).tables.find(
    (candidate) => candidate.name === name
  );
  if (table === undefined) throw new Error(`no table '${name}'`);
  return table;
}

/** Each column's declared type, by name. */
function columnTypes(schema: Schema, dialect: Dialect, name: string) {
  return Object.fromEntries(
    tableOf(schema, dialect, name).columns.map((column) => [
      column.name,
      column.type,
    ])
  );
}

/** The junction's keys, by the table each references. */
function junctionKeys(schema: Schema, dialect: Dialect) {
  return Object.fromEntries(
    tableOf(schema, dialect, JUNCTION_TABLE).foreignKeys.map((key) => [
      key.referencedTable,
      { columns: key.columns, onDelete: key.onDelete, onUpdate: key.onUpdate },
    ])
  );
}

/** Which of `post`'s scalars the update admission refuses. */
function refusedPostUpdates(schema: Schema): string[] {
  const update = createSchemaRegistry(schema).proxy.post!.core.update;
  return ["title", "createdAt"].filter(
    (key) => parse(update, { [key]: LATER }).issues !== undefined
  );
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) return error.message;
    throw error;
  }
  throw new Error("the payload was admitted");
}

/** Each diff operation as `type table.column-or-key`. */
async function plannedBetween(from: Schema, to: Schema, dialect: Dialect) {
  const result = await diff(snapshotOf(from, dialect), snapshotOf(to, dialect));
  return result.operations.map((operation) => {
    switch (operation.type) {
      case "alterColumn":
        return `alterColumn ${operation.tableName}.${operation.to.name}`;
      case "dropForeignKey":
        return `dropForeignKey ${operation.tableName}.${operation.fkName}`;
      case "addForeignKey":
        return `addForeignKey ${operation.tableName}.${operation.fk.name}`;
      default:
        return operation.type;
    }
  });
}

describe("combined falsifier 1: one document carries all three declarations", () => {
  it("states the native maps, the creation timestamp and the side map", () => {
    const post = serializeSchema(combinationSchema()).models.post?.fields;
    expect(post?.title).toEqual({
      type: "string",
      nativeByDialect: TITLE_STORAGE,
    });
    expect(post?.createdAt).toEqual({
      type: "datetime",
      nativeByDialect: CREATED_STORAGE,
      generate: { kind: "now" },
    });
    expect(post?.topics).toEqual({
      type: "toMany",
      target: "topic",
      junction: {
        table: JUNCTION_TABLE,
        onDeleteSides: { source: "cascade", target: "noAction" },
        onUpdate: "cascade",
      },
    });
  });

  it("parse → serialize is the identity, and the parsed schema is physically the same", () => {
    const document = serializeSchema(combinationSchema());
    const reparsed = parseSchema(document, { validate: true });
    expect(serializeSchema(reparsed)).toEqual(document);
    for (const dialect of EACH_DIALECT) {
      expect(snapshotOf(reparsed, dialect)).toEqual(
        snapshotOf(combinationSchema(), dialect)
      );
    }
  });

  it("the parsed schema keeps the creation timestamp insert-only, and only it", () => {
    expect(refusedPostUpdates(combinationSchema())).toEqual(["createdAt"]);
    expect(
      refusedPostUpdates(parseSchema(serializeSchema(combinationSchema())))
    ).toEqual(["createdAt"]);
  });
});

describe("combined falsifier 2: junction keys inherit each dialect's storage", () => {
  const EXPECTED = {
    postgres: { postId: "bytea", topicId: "varchar(30)" },
    mysql: { postId: "VARCHAR(36)", topicId: "VARCHAR(30)" },
    sqlite: { postId: "BLOB", topicId: "TEXT" },
  } as const;

  for (const dialect of EACH_DIALECT) {
    it(`${dialect}: each junction key column is its referenced key's type, with its own side's actions`, () => {
      const schema = combinationSchema();
      const junction = columnTypes(schema, dialect, JUNCTION_TABLE);
      expect(junction).toEqual(EXPECTED[dialect]);
      expect(junction.postId).toBe(columnTypes(schema, dialect, "bbb_post").id);
      expect(junction.topicId).toBe(
        columnTypes(schema, dialect, "aaa_topic").id
      );
      expect(junctionKeys(schema, dialect)).toEqual({
        bbb_post: {
          columns: ["postId"],
          onDelete: "cascade",
          onUpdate: "cascade",
        },
        aaa_topic: {
          columns: ["topicId"],
          onDelete: "noAction",
          onUpdate: "cascade",
        },
      });
    });
  }

  it("the creation timestamp still refuses a root, a nested and an upsert update", () => {
    const schema = combinationSchema();
    const where = { id: POST_ID };
    expect(
      refusal(() =>
        validateOperationPayload(schema, "post", "update", {
          where,
          data: { title: "renamed", createdAt: LATER },
        })
      )
    ).toContain("Unknown key: createdAt");
    expect(
      refusal(() =>
        validateOperationPayload(schema, "topic", "update", {
          where: { id: "t1" },
          data: {
            posts: { update: { where, data: { createdAt: LATER } } },
          },
        })
      )
    ).toContain("Unknown key: createdAt");
    expect(
      refusal(() =>
        validateOperationPayload(schema, "post", "upsert", {
          where,
          create: { title: "new", createdAt: LATER },
          update: { createdAt: LATER },
        })
      )
    ).toContain("Unknown key: createdAt");
  });

  it("creating through the junction still accepts an explicit creation time", () => {
    const schema = combinationSchema();
    expect(() =>
      validateOperationPayload(schema, "topic", "update", {
        where: { id: "t1" },
        data: {
          posts: { create: { title: "fresh", createdAt: LATER } },
        },
      })
    ).not.toThrow();
  });
});

describe("combined falsifier 4 (snapshots): only the changed declaration plans work", () => {
  /** Each dialect's active entry of one map moved. */
  const ACTIVE_CHANGE = {
    postgres: {
      title: { ...TITLE_STORAGE, pg: PG.STRING.VARCHAR(120) },
      column: "bbb_post.title",
    },
    mysql: {
      title: { ...TITLE_STORAGE, mysql: MYSQL.STRING.VARCHAR(120) },
      column: "bbb_post.title",
    },
    sqlite: {
      created: { sqlite: SQLITE.DATETIME.REAL },
      column: "bbb_post.createdAt",
    },
  } as const;

  for (const dialect of EACH_DIALECT) {
    it(`${dialect}: a junction policy change replaces the topic key alone`, async () => {
      expect(
        await plannedBetween(
          combinationSchema(),
          combinationSchema({ topicDelete: "restrict" }),
          dialect
        )
      ).toEqual([
        `dropForeignKey ${JUNCTION_TABLE}.${JUNCTION_TABLE}_topicId_fkey`,
        `addForeignKey ${JUNCTION_TABLE}.${JUNCTION_TABLE}_topicId_fkey`,
      ]);
    });

    it(`${dialect}: its own native entry is a change, the other dialects' are not`, async () => {
      const { column, ...own } = ACTIVE_CHANGE[dialect];
      expect(
        await plannedBetween(
          combinationSchema(),
          combinationSchema(own),
          dialect
        )
      ).toEqual([`alterColumn ${column}`]);
      for (const other of EACH_DIALECT.filter((name) => name !== dialect)) {
        const { column: _column, ...foreign } = ACTIVE_CHANGE[other];
        expect(
          await plannedBetween(
            combinationSchema(),
            combinationSchema(foreign),
            dialect
          )
        ).toEqual([]);
      }
    });

    it(`${dialect}: respelling the same physical schema plans nothing`, async () => {
      expect(
        await plannedBetween(
          combinationSchema(),
          combinationSchema({ respelled: true }),
          dialect
        )
      ).toEqual([]);
    });
  }
});
