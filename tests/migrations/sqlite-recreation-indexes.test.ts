/**
 * What a SQLite table recreation does to the batch's own indexes.
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
 * FIX: `SQLite3MigrationDriver.getCurrentTable` replays the batch's preceding
 * `createIndex` / `dropIndex` operations — the only two that move an index in or
 * out of `TableDef.indexes` — onto the introspected list, so a recreation
 * rebuilds the indexes the table holds at the moment it runs.
 *
 * This file is the driver-agnostic witness. The live upgrade push is
 * `runFkIndexUpgradeBehavior` in `tests/drivers/fk-index-behavior.ts`.
 */

import { describe, expect, it } from "vitest";
import { sqlite3MigrationDriver } from "../../src/migrations/drivers/sqlite";
import { generateDDLStatements } from "../../src/migrations/push/executor";
import type {
  DiffOperation,
  IndexDef,
  SchemaSnapshot,
} from "../../src/migrations/types";
import { sortOperations } from "../../src/migrations/utils";

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
