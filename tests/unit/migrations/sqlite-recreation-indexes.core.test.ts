/**
 * What a SQLite table recreation does to the batch's own work.
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
 * The SAME pre-batch read reached the COLUMNS, the UNIQUE CONSTRAINTS and the
 * PRIMARY KEY, and none of those needed a foreign key to go wrong. `addColumn`
 * runs at priority 10 and `alterColumn` at 12, and on SQLite `alterColumn` is
 * itself a recreation: measured live on better-sqlite3, pushing a model that
 * widened one column and added another emitted the `ALTER TABLE ... ADD COLUMN`
 * and then rebuilt the table WITHOUT it. The push reported success, the column
 * was gone, and the next push added and lost it again. Two `alterColumn`s in one
 * batch reverted each other the same way, and a `dropColumn` before a recreation
 * asked the source table for a column it no longer had, which aborted the push.
 *
 * FIX: `SQLite3MigrationDriver.getCurrentTable` replays every preceding
 * operation of the batch that names this table onto the introspected
 * definition — that is all the operations that move a column, an index, a
 * foreign key, a unique constraint or the primary key in or out of `TableDef` —
 * so a recreation rebuilds what the table holds at the moment it runs.
 *
 * This file is the driver-agnostic witness, plus one live push that counts the
 * keys the database ends up with. The live index upgrade is
 * `runFkIndexUpgradeBehavior` in `tests/drivers/fk-index-behavior.ts`; the
 * separate defect that made SQLite plan this churn on EVERY push — a
 * constraint name introspection cannot read back — is
 * `constraint-identity.test.ts`.
 */

import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { generateDDLStatements } from "@src/migrations/push/executor";
import type {
  DiffOperation,
  IndexDef,
  SchemaSnapshot,
} from "@src/migrations/types";
import { sortOperations } from "@src/migrations/utils";
import { describe, expect, it } from "vitest";

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

/** The column names of the last `CREATE TABLE` in a batch, in order. */
function columnsOfLastRebuild(statements: string[]): string[] {
  const last = statements
    .filter((statement) => statement.startsWith("CREATE TABLE"))
    .at(-1);
  return [...(last ?? "").matchAll(REBUILT_COLUMN)].map(
    (match) => match[1] as string
  );
}

/** A leading `"name" TYPE` line of a CREATE TABLE body. */
const REBUILT_COLUMN = /^\s{2}"([^"]+)" (?:TEXT|INTEGER|REAL|BLOB)/gm;

describe("SQLite table recreation — the batch's own columns", () => {
  const alterAuthorId: DiffOperation = {
    type: "alterColumn",
    tableName: "posts",
    columnName: "author_id",
    from: { name: "author_id", type: "TEXT", nullable: false },
    to: { name: "author_id", type: "INTEGER", nullable: false },
  };

  // REGRESSION: `addColumn` runs at priority 10 and `alterColumn` at 12, and on
  // SQLite `alterColumn` IS a recreation. Read from the pre-batch column list
  // the rebuild dropped the table and re-created it WITHOUT the column the
  // `ALTER TABLE ... ADD COLUMN` two statements earlier had just added.
  // Measured live on better-sqlite3: pushing a model that widened one column
  // and added another reported success and left the new column gone — and the
  // next push added and lost it again, forever.
  it("carries a column the same batch added before it", () => {
    const statements = sqliteStatements(
      [
        {
          type: "addColumn",
          tableName: "posts",
          column: { name: "subtitle", type: "TEXT", nullable: true },
        },
        alterAuthorId,
      ],
      postsSnapshot([])
    );

    expect(columnsOfLastRebuild(statements)).toEqual([
      "id",
      "author_id",
      "slug",
      "subtitle",
    ]);
    // And the copy reads the column from the table that now has it.
    expect(
      statements.some((s) =>
        s.includes('SELECT "id", "author_id", "slug", "subtitle"')
      )
    ).toBe(true);
  });

  it("does not resurrect a column the same batch dropped before it", () => {
    // Left stale, the rebuild both re-created `slug` and asked the source table
    // for it — and the source no longer had it, so the push aborted.
    const statements = sqliteStatements(
      [
        { type: "dropColumn", tableName: "posts", columnName: "slug" },
        alterAuthorId,
      ],
      postsSnapshot([])
    );

    expect(columnsOfLastRebuild(statements)).toEqual(["id", "author_id"]);
  });

  it("does not revert an alterColumn the same batch already applied", () => {
    // Two recreations in one batch: the second read the pre-batch columns, so
    // it rebuilt the table around the type the FIRST one had just replaced.
    const statements = sqliteStatements(
      [
        alterAuthorId,
        {
          type: "alterColumn",
          tableName: "posts",
          columnName: "slug",
          from: { name: "slug", type: "TEXT", nullable: false },
          to: { name: "slug", type: "TEXT", nullable: true },
        },
      ],
      postsSnapshot([])
    );

    const rebuild = statements
      .filter((s) => s.startsWith("CREATE TABLE"))
      .at(-1);
    expect(rebuild).toContain('"author_id" INTEGER');
    expect(rebuild).not.toContain('"author_id" TEXT');
  });
});

describe("SQLite table recreation — the batch's own unique constraints and key", () => {
  it("carries a unique constraint the same batch added before it", () => {
    // `addUniqueConstraint` runs at 14, before `addForeignKey` at 16. On
    // SQLite the constraint is INLINE in `CREATE TABLE`
    // (`sqlite-unique-constraint.test.ts`), so the later rebuild has to carry
    // it forward or the `DROP TABLE` at 16 takes it away.
    const statements = sqliteStatements(
      [
        {
          type: "addUniqueConstraint",
          tableName: "posts",
          constraint: { name: "posts_slug_key", columns: ["slug"] },
        },
        addSerializedFk,
      ],
      postsSnapshot([])
    );

    expect(
      statements.filter((s) => s.startsWith("CREATE TABLE")).at(-1)
    ).toContain('CONSTRAINT "posts_slug_key" UNIQUE ("slug")');
  });

  it("rebuilds around the primary key the same batch installed", () => {
    const statements = sqliteStatements(
      [
        {
          type: "addPrimaryKey",
          tableName: "posts",
          primaryKey: { columns: ["id", "slug"] },
        },
        addSerializedFk,
      ],
      postsSnapshot([])
    );

    expect(
      statements.filter((s) => s.startsWith("CREATE TABLE")).at(-1)
    ).toContain('PRIMARY KEY ("id", "slug")');
  });
});

// --- The live push ----------------------------------------------------------
