/**
 * What a SQLite table recreation does to the batch's own indexes and foreign
 * keys.
 *
 * REGRESSION: SQLite has no `ALTER TABLE ... ADD FOREIGN KEY`, so every foreign
 * key change rebuilds the table — create a `__new_` table, copy, `DROP TABLE`,
 * rename — and `DROP TABLE` takes the table's indexes with it. The rebuild read
 * its index list from `DDLContext.currentSchema`, which is introspected once
 * before the batch starts. `createIndex` runs at priority 15 and
 * `addForeignKey` at 16, so the recreation re-created the *pre-batch* indexes
 * and threw away everything the same batch had just created.
 *
 * That is not a corner. SQLite's introspection cannot read constraint names
 * (`PRAGMA foreign_key_list` has none), so it synthesises `<table>_fk_<n>` and
 * the differ — which matches foreign keys by name — plans a drop and an add on
 * every push for every `manyToOne`. On any database that predates the FK index
 * this phase emits, each push therefore created the index and destroyed it in
 * the same transaction, forever: the index never landed and `push` never went
 * quiet.
 *
 * The SAME pre-batch read did the same thing to FOREIGN KEYS, and there it did
 * not merely lose work — it undid a drop. The differ plans `dropForeignKey`
 * (priority 2) then `addForeignKey` (priority 16) for every changed key, which
 * on SQLite is exactly the pair every `manyToOne` push plans, forever, for the
 * synthesised-name reason above. The add rebuilt the table from the pre-batch
 * list, which still held the key the drop had just removed, and appended the
 * replacement: `zz_posts` came out of push 1 with one foreign key, push 2 with
 * two, push 3 with three — accumulating without bound, each one separately
 * enforced. (Measured on better-sqlite3; the two spellings are identical
 * constraints, so the growth is invisible until a delete meets three
 * referential actions instead of one.)
 *
 * FIX: `SQLite3MigrationDriver.getCurrentTable` replays the batch's preceding
 * `createIndex` / `dropIndex` / `addForeignKey` / `dropForeignKey` operations —
 * the only four that move an index or a foreign key in or out of `TableDef` —
 * onto the introspected lists, so a recreation rebuilds what the table holds at
 * the moment it runs.
 *
 * This file is the driver-agnostic witness, plus one live push that counts the
 * keys the database ends up with. The live index upgrade is
 * `runFkIndexUpgradeBehavior` in `tests/drivers/fk-index-behavior.ts`.
 */

import { createClient } from "@client/client";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { sqlite3MigrationDriver } from "../../src/migrations/drivers/sqlite";
import { generateDDLStatements } from "../../src/migrations/push/executor";
import type {
  DiffOperation,
  IndexDef,
  SchemaSnapshot,
} from "../../src/migrations/types";
import { sortOperations } from "../../src/migrations/utils";
import { createInMemorySQLite3Driver } from "../fixtures/drivers/sqlite3";

/** The shape of a to-many child table, with whatever indexes it already has. */
function postsSnapshot(indexes: IndexDef[]): SchemaSnapshot {
  return {
    tables: [
      {
        name: "posts",
        columns: [
          { name: "id", type: "TEXT", nullable: false },
          { name: "author_id", type: "TEXT", nullable: false },
          { name: "slug", type: "TEXT", nullable: false },
        ],
        primaryKey: { columns: ["id"] },
        indexes,
        foreignKeys: [
          {
            name: "posts_fk_0",
            columns: ["author_id"],
            referencedTable: "users",
            referencedColumns: ["id"],
            onDelete: "restrict",
            onUpdate: "noAction",
          },
        ],
        uniqueConstraints: [],
      },
    ],
  };
}

const fkIndex: IndexDef = {
  name: "posts_author_id_idx",
  columns: ["author_id"],
  unique: false,
};

/** The FK churn SQLite plans on every push: drop the read name, add the real one. */
const dropSynthesisedFk: DiffOperation = {
  type: "dropForeignKey",
  tableName: "posts",
  fkName: "posts_fk_0",
};

const addSerializedFk: DiffOperation = {
  type: "addForeignKey",
  tableName: "posts",
  fk: {
    name: "posts_author_id_fkey",
    columns: ["author_id"],
    referencedTable: "users",
    referencedColumns: ["id"],
    onDelete: "restrict",
    onUpdate: "noAction",
  },
};

const MOVES_A_TABLE_OR_INDEX =
  /^(CREATE (UNIQUE )?INDEX|DROP TABLE|DROP INDEX)/;

/** Only the statements that move a table or an index; the rest is copy plumbing. */
function indexShape(statements: string[]): string[] {
  return statements.filter((statement) =>
    MOVES_A_TABLE_OR_INDEX.test(statement)
  );
}

function sqliteStatements(
  operations: DiffOperation[],
  snapshot: SchemaSnapshot
): string[] {
  return generateDDLStatements(
    sortOperations(operations),
    sqlite3MigrationDriver,
    snapshot
  );
}

describe("SQLite table recreation — the batch's own indexes", () => {
  it("re-creates an index the same batch created before it", () => {
    const statements = sqliteStatements(
      [
        dropSynthesisedFk,
        { type: "createIndex", tableName: "posts", index: fkIndex },
        addSerializedFk,
      ],
      // The database predates the FK index: it is nowhere in the snapshot.
      postsSnapshot([])
    );

    expect(indexShape(statements)).toEqual([
      // The FK drop rebuilds the table; there is no index to carry yet.
      'DROP TABLE "posts"',
      'CREATE INDEX "posts_author_id_idx" ON "posts" ("author_id")',
      // The FK add rebuilds it again — and puts the index back.
      'DROP TABLE "posts"',
      'CREATE INDEX "posts_author_id_idx" ON "posts" ("author_id")',
    ]);
  });

  it("does not resurrect an index the same batch dropped before it", () => {
    const wider: IndexDef = {
      name: "posts_author_id_slug_idx",
      columns: ["author_id", "slug"],
      unique: false,
    };

    const statements = sqliteStatements(
      [
        dropSynthesisedFk,
        { type: "dropIndex", tableName: "posts", indexName: fkIndex.name },
        { type: "createIndex", tableName: "posts", index: wider },
        addSerializedFk,
      ],
      postsSnapshot([fkIndex])
    );

    expect(indexShape(statements)).toEqual([
      // The FK drop still carries the index the database has at that point.
      'DROP TABLE "posts"',
      'CREATE INDEX "posts_author_id_idx" ON "posts" ("author_id")',
      'CREATE INDEX "posts_author_id_slug_idx" ON "posts" ("author_id", "slug")',
      'DROP INDEX "posts_author_id_idx"',
      // The FK add rebuilds the table around the replacement, and only it.
      'DROP TABLE "posts"',
      'CREATE INDEX "posts_author_id_slug_idx" ON "posts" ("author_id", "slug")',
    ]);
  });
});

/** The `CONSTRAINT "<name>"` clauses of the last `CREATE TABLE` in a batch. */
function fkNamesOfLastRebuild(statements: string[]): string[] {
  const creates = statements.filter((statement) =>
    statement.startsWith("CREATE TABLE")
  );
  const last = creates.at(-1) ?? "";
  return [...last.matchAll(FK_CONSTRAINT)].map((match) => match[1] as string);
}

const FK_CONSTRAINT = /CONSTRAINT "([^"]+)" FOREIGN KEY/g;

describe("SQLite table recreation — the batch's own foreign keys", () => {
  it("does not resurrect a foreign key the same batch dropped before it", () => {
    const statements = sqliteStatements(
      [dropSynthesisedFk, addSerializedFk],
      postsSnapshot([])
    );

    // Only the key the batch ADDS. The dropped `posts_fk_0` is gone for good;
    // before the replay it came back, and the table left the push holding both.
    expect(fkNamesOfLastRebuild(statements)).toEqual(["posts_author_id_fkey"]);
  });

  it("keeps one key when the same name is dropped and re-added", () => {
    // The ordinary "changed referential action" edit: one name, new definition.
    const statements = sqliteStatements(
      [
        { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_0" },
        {
          type: "addForeignKey",
          tableName: "posts",
          fk: {
            name: "posts_fk_0",
            columns: ["author_id"],
            referencedTable: "users",
            referencedColumns: ["id"],
            onDelete: "cascade",
            onUpdate: "noAction",
          },
        },
      ],
      postsSnapshot([])
    );

    expect(fkNamesOfLastRebuild(statements)).toEqual(["posts_fk_0"]);
    // And it is the NEW definition, not the one the drop removed.
    const rebuild = statements
      .filter((s) => s.startsWith("CREATE TABLE"))
      .at(-1);
    expect(rebuild).toContain("ON DELETE CASCADE");
    expect(rebuild).not.toContain("ON DELETE RESTRICT");
  });
});

// --- The live push ----------------------------------------------------------
const recreationUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => recreationPost),
  })
  .map("recreation_users");

const recreationPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    author: s
      .manyToOne(() => recreationUser)
      .fields("authorId")
      .references("id"),
  })
  .map("recreation_posts");

describe("SQLite foreign keys across repeated pushes", () => {
  it("holds exactly one foreign key however many times the schema is pushed", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: { recreationUser, recreationPost } as never,
      driver,
    }) as never;

    const counts: number[] = [];
    for (let round = 0; round < 3; round++) {
      await push(client, { force: true });
      const read = (await driver._executeRaw(
        "PRAGMA foreign_key_list(recreation_posts)"
      )) as unknown as { rows?: unknown[] };
      counts.push((read.rows ?? (read as unknown as unknown[])).length);
    }

    // [1, 2, 3] before the replay: every push added another copy.
    expect(counts).toEqual([1, 1, 1]);
  });
});
