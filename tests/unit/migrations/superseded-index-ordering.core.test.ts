/**
 * Superseded-index DDL ordering.
 *
 * REGRESSION: `sortOperations` ran every `dropIndex` (priority 3) before every
 * `createIndex` (15) and `addUniqueConstraint` (14). MySQL binds a foreign key
 * to whichever index covers its columns and refuses to drop that index while it
 * is the last one covering them — errno 1553, `HY000`. So the moment a schema
 * edit *supersedes* an FK-covering index (widening it, or covering the same
 * columns with a compound unique), the batch dropped the old index before its
 * replacement existed and the whole transactional push aborted.
 *
 * Reachable from the documented path: the FK index viborm now emits for every
 * `manyToOne` is the only index on the column, so InnoDB binds the constraint to
 * it, and `docs/content/docs/schema/model.mdx` tells the user to declare a wider
 * index over the same fields when they want more columns in it.
 *
 * FIX: a `dropIndex` whose replacement is created in the same batch is moved to
 * a slot between `createIndex` and `addForeignKey`. Two arrangements keep their
 * early slot — a create of the same *name* (the name has to be free before it is
 * taken again) and any table that also drops a column (the column drop takes its
 * indexes with it).
 *
 * This file is the driver-agnostic witness (operation order + emitted DDL). The
 * live MySQL/InnoDB push is in `tests/drivers/fk-index-behavior.ts`; the two
 * live pushes below cover the dialects that scope an index name to the schema.
 */

import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import type { DiffOperation } from "@src/migrations/types";
import { sortOperations } from "@src/migrations/utils";
import { ddlContext } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

function dropIndex(tableName: string, indexName: string): DiffOperation {
  return { type: "dropIndex", tableName, indexName };
}

function createIndex(
  tableName: string,
  name: string,
  columns: string[]
): DiffOperation {
  return {
    type: "createIndex",
    tableName,
    index: { name, columns, unique: false },
  };
}

function dropColumn(tableName: string, columnName: string): DiffOperation {
  return { type: "dropColumn", tableName, columnName };
}

/** How each operation is spelled in the order assertions below. */
function label(op: DiffOperation): string {
  switch (op.type) {
    case "dropIndex":
      return `dropIndex:${op.indexName}`;
    case "createIndex":
      return `createIndex:${op.index.name}`;
    case "dropColumn":
      return `dropColumn:${op.columnName}`;
    case "addUniqueConstraint":
      return `addUniqueConstraint:${op.constraint.name}`;
    case "addForeignKey":
      return `addForeignKey:${op.fk.name}`;
    default:
      return op.type;
  }
}

const order = (ops: DiffOperation[]) => sortOperations(ops).map(label);

describe("sortOperations — a superseded index drop follows its replacement", () => {
  it("orders the drop after a differently-named create on the same table", () => {
    expect(
      order([
        dropIndex("posts", "posts_authorId_idx"),
        createIndex("posts", "posts_authorId_createdAt_idx", [
          "authorId",
          "createdAt",
        ]),
      ])
    ).toEqual([
      "createIndex:posts_authorId_createdAt_idx",
      "dropIndex:posts_authorId_idx",
    ]);
  });

  it("orders the drop after a compound unique over the same columns", () => {
    const addUnique: DiffOperation = {
      type: "addUniqueConstraint",
      tableName: "posts",
      constraint: {
        name: "posts_authorId_slug_key",
        columns: ["authorId", "slug"],
      },
    };

    expect(
      order([dropIndex("posts", "posts_authorId_idx"), addUnique])
    ).toEqual([
      "addUniqueConstraint:posts_authorId_slug_key",
      "dropIndex:posts_authorId_idx",
    ]);
  });

  it("still runs the drop before a foreign key added in the same batch", () => {
    const addFk: DiffOperation = {
      type: "addForeignKey",
      tableName: "posts",
      fk: {
        name: "posts_authorId_fkey",
        columns: ["authorId"],
        referencedTable: "users",
        referencedColumns: ["id"],
        onDelete: "restrict",
        onUpdate: "noAction",
      },
    };

    expect(
      order([
        dropIndex("posts", "posts_authorId_idx"),
        createIndex("posts", "posts_authorId_createdAt_idx", [
          "authorId",
          "createdAt",
        ]),
        addFk,
      ])
    ).toEqual([
      "createIndex:posts_authorId_createdAt_idx",
      "dropIndex:posts_authorId_idx",
      "addForeignKey:posts_authorId_fkey",
    ]);
  });
});

describe("sortOperations — the arrangements that keep the early slot", () => {
  // REGRESSION: this exclusion used to be keyed on (table, name), so a batch
  // that freed a name on one table and took it on another was not recognised
  // as a same-name pair and the drop was deferred past the create. PostgreSQL
  // and SQLite scope an index name to the schema, not to its table: the create
  // then hit an occupied name — Postgres 42P07 — and the push aborted. The live
  // pushes at the bottom of this file are the witness.
  it("drops first when another table takes the same name", () => {
    expect(
      order([
        dropIndex("posts", "shared_name"),
        createIndex("comments", "shared_name", ["authorId"]),
      ])
    ).toEqual(["dropIndex:shared_name", "createIndex:shared_name"]);
  });

  it("drops first when the same name is re-created (the differ's changed-index pair)", () => {
    expect(
      order([
        dropIndex("posts", "posts_by_author"),
        createIndex("posts", "posts_by_author", ["authorId", "createdAt"]),
      ])
    ).toEqual(["dropIndex:posts_by_author", "createIndex:posts_by_author"]);
  });

  it("keeps a same-name pair first even when the batch has another create", () => {
    expect(
      order([
        dropIndex("posts", "posts_by_author"),
        createIndex("posts", "posts_by_author", ["authorId", "createdAt"]),
        dropIndex("posts", "posts_slug_idx"),
        createIndex("posts", "posts_slug_title_idx", ["slug", "title"]),
      ])
    ).toEqual([
      "dropIndex:posts_by_author",
      "createIndex:posts_by_author",
      "createIndex:posts_slug_title_idx",
      "dropIndex:posts_slug_idx",
    ]);
  });

  it("drops first when the same table also drops a column", () => {
    expect(
      order([
        dropIndex("posts", "posts_slug_idx"),
        dropColumn("posts", "slug"),
        createIndex("posts", "posts_authorId_createdAt_idx", [
          "authorId",
          "createdAt",
        ]),
      ])
    ).toEqual([
      "dropIndex:posts_slug_idx",
      "dropColumn:slug",
      "createIndex:posts_authorId_createdAt_idx",
    ]);
  });

  it("scopes the column drop to its own table", () => {
    expect(
      order([
        dropIndex("posts", "posts_authorId_idx"),
        createIndex("posts", "posts_authorId_createdAt_idx", [
          "authorId",
          "createdAt",
        ]),
        dropColumn("comments", "body"),
      ])
    ).toEqual([
      "dropColumn:body",
      "createIndex:posts_authorId_createdAt_idx",
      "dropIndex:posts_authorId_idx",
    ]);
  });
});

describe("emitted DDL — MySQL creates the wider index before dropping the old one", () => {
  it("puts CREATE INDEX ahead of DROP INDEX", () => {
    const statements = sortOperations([
      dropIndex("posts", "posts_authorId_idx"),
      createIndex("posts", "posts_authorId_createdAt_idx", [
        "authorId",
        "createdAt",
      ]),
    ]).map((op) =>
      mysqlMigrationDriver.generateDDL(op, ddlContext("artifact"))
    );

    expect(statements).toEqual([
      "CREATE INDEX `posts_authorId_createdAt_idx` ON `posts` (`authorId`, `createdAt`)",
      "DROP INDEX `posts_authorId_idx` ON `posts`",
    ]);
  });
});

// The schema-scoped half, pushed for real. Moving a named index from one model
// to another is the whole edit: the name has to be released before it is taken.
