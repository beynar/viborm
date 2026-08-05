/**
 * What makes two constraints the same constraint.
 *
 * REGRESSION: the differ matched foreign keys and unique constraints by NAME.
 * On PostgreSQL and MySQL that is right — the catalog carries the name the DDL
 * gave the constraint. SQLite carries neither name:
 *
 *   - `PRAGMA foreign_key_list` has no name column at all, so introspection
 *     synthesises `<table>_fk_<n>`, which never equals the serializer's
 *     `<table>_<column>_fkey`;
 *   - an inline `CONSTRAINT x UNIQUE (...)` is reported by `PRAGMA index_list`
 *     only as `sqlite_autoindex_<table>_<n>`, and the declared name is gone.
 *
 * So on SQLite every unchanged constraint read as "the declared one is missing,
 * the read one is extra" on every push, forever, and the two repairs the differ
 * planned were both wrong. Measured on better-sqlite3 at f33d16a:
 *
 *   - FOREIGN KEY: push #2 and every push after it planned
 *     `dropForeignKey` + `addForeignKey`. SQLite has no
 *     `ALTER TABLE ADD FOREIGN KEY`, so each is a full table rebuild — two per
 *     push, copy included, for a schema nobody edited.
 *   - UNIQUE: push #2 planned `dropUniqueConstraint`, whose SQLite spelling is
 *     `DROP INDEX "sqlite_autoindex_arc_posts_2"` — which SQLite refuses. The
 *     SECOND push of any SQLite schema carrying a compound unique FAILED.
 *
 * FIX: `planPush` reads the migration driver's
 * `introspectionReadsConstraintNames` capability and, where the name cannot be
 * read, tells the differ to recognize both constraints by their SHAPE instead —
 * the columns, what they point at, and what happens on delete and update.
 *
 * The residue this did NOT close was SQLite's unique-constraint DDL: the add
 * emitted a standalone `CREATE UNIQUE INDEX` and the drop a `DROP INDEX` on a
 * name SQLite owns. Both now go through a table recreation, so the constraint
 * is always inline — `sqlite-unique-constraint.test.ts`. Note the direction
 * that file records: this shape matching is what UNMASKED the add's failure,
 * because before it the foreign-key churn destroyed the just-created index on
 * every push and the constraint was silently never enforced.
 */

import { createClient } from "@client/client";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { diff } from "../../src/migrations/differ";
import type {
  DiffOperation,
  ForeignKeyDef,
  SchemaSnapshot,
  TableDef,
} from "../../src/migrations/types";
import { createInMemorySQLite3Driver } from "../fixtures/drivers/sqlite3";

// --- The differ, both identities -------------------------------------------

function posts(overrides: Partial<TableDef>): SchemaSnapshot {
  return {
    tables: [
      {
        name: "posts",
        columns: [
          { name: "id", type: "TEXT", nullable: false },
          { name: "author_id", type: "TEXT", nullable: false },
        ],
        primaryKey: { columns: ["id"] },
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [],
        ...overrides,
      },
    ],
  };
}

/** The key as SQLite's introspection reports it: a synthesised name. */
const readFk: ForeignKeyDef = {
  name: "posts_fk_0",
  columns: ["author_id"],
  referencedTable: "users",
  referencedColumns: ["id"],
  onDelete: "restrict",
  onUpdate: "noAction",
};

/** The same key as the serializer declares it. */
const declaredFk: ForeignKeyDef = { ...readFk, name: "posts_author_id_fkey" };

async function byShape(
  current: SchemaSnapshot,
  desired: SchemaSnapshot
): Promise<DiffOperation[]> {
  const result = await diff(current, desired, {
    matchConstraintsByShape: true,
  });
  return result.operations;
}

async function byName(
  current: SchemaSnapshot,
  desired: SchemaSnapshot
): Promise<DiffOperation[]> {
  const result = await diff(current, desired);
  return result.operations;
}

describe("foreign-key identity by shape", () => {
  it("reads an unchanged key under a synthesised name as no change", async () => {
    expect(
      await byShape(
        posts({ foreignKeys: [readFk] }),
        posts({ foreignKeys: [declaredFk] })
      )
    ).toEqual([]);
  });

  it("still sees a changed referential action", async () => {
    const changed: ForeignKeyDef = { ...declaredFk, onDelete: "cascade" };

    expect(
      await byShape(
        posts({ foreignKeys: [readFk] }),
        posts({ foreignKeys: [changed] })
      )
    ).toEqual([
      { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_0" },
      { type: "addForeignKey", tableName: "posts", fk: changed },
    ]);
  });

  it("still sees a changed referenced column", async () => {
    const changed: ForeignKeyDef = {
      ...declaredFk,
      referencedColumns: ["uid"],
    };

    expect(
      await byShape(
        posts({ foreignKeys: [readFk] }),
        posts({ foreignKeys: [changed] })
      )
    ).toEqual([
      { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_0" },
      { type: "addForeignKey", tableName: "posts", fk: changed },
    ]);
  });

  it("still sees a key the schema dropped", async () => {
    expect(await byShape(posts({ foreignKeys: [readFk] }), posts({}))).toEqual([
      { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_0" },
    ]);
  });

  it("keeps one copy and drops the extras a legacy database accumulated", async () => {
    // A database written before the recreation replay landed holds several
    // byte-identical keys. Matching as a MULTISET is what still repairs that:
    // one shape on the desired side pairs with one on the current side, and
    // the other two stay unmatched, which is what drops them.
    expect(
      await byShape(
        posts({
          foreignKeys: [
            readFk,
            { ...readFk, name: "posts_fk_1" },
            { ...readFk, name: "posts_fk_2" },
          ],
        }),
        posts({ foreignKeys: [declaredFk] })
      )
    ).toEqual([
      { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_1" },
      { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_2" },
    ]);
  });

  it("reads an undeclared action as NO ACTION", async () => {
    // Every introspection reads a concrete action back from the catalog; a
    // snapshot may leave it undefined. Both spell the same constraint.
    const undeclared: ForeignKeyDef = {
      name: "posts_author_id_fkey",
      columns: ["author_id"],
      referencedTable: "users",
      referencedColumns: ["id"],
    };

    expect(
      await byShape(
        posts({
          foreignKeys: [
            { ...readFk, onDelete: "noAction", onUpdate: "noAction" },
          ],
        }),
        posts({ foreignKeys: [undeclared] })
      )
    ).toEqual([]);
  });
});

describe("foreign-key identity by name (the dialects that carry one)", () => {
  it("a renamed key is a different key", async () => {
    // The name IS the identity on PostgreSQL and MySQL, so this must stay a
    // drop and an add — the shape reading would call it no change.
    expect(
      await byName(
        posts({ foreignKeys: [readFk] }),
        posts({ foreignKeys: [declaredFk] })
      )
    ).toEqual([
      { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_0" },
      { type: "addForeignKey", tableName: "posts", fk: declaredFk },
    ]);
  });

  it("one name whose definition changed is dropped and re-added", async () => {
    const changed: ForeignKeyDef = { ...readFk, onDelete: "cascade" };

    expect(
      await byName(
        posts({ foreignKeys: [readFk] }),
        posts({ foreignKeys: [changed] })
      )
    ).toEqual([
      { type: "dropForeignKey", tableName: "posts", fkName: "posts_fk_0" },
      { type: "addForeignKey", tableName: "posts", fk: changed },
    ]);
  });
});

describe("unique-constraint identity by shape", () => {
  const read = { name: "sqlite_autoindex_posts_2", columns: ["author_id"] };
  const declared = { name: "posts_author_id_key", columns: ["author_id"] };

  it("reads an unchanged constraint under SQLite's own name as no change", async () => {
    expect(
      await byShape(
        posts({ uniqueConstraints: [read] }),
        posts({ uniqueConstraints: [declared] })
      )
    ).toEqual([]);
  });

  it("still sees a changed column list", async () => {
    const wider = {
      name: "posts_author_id_id_key",
      columns: ["author_id", "id"],
    };

    expect(
      await byShape(
        posts({ uniqueConstraints: [read] }),
        posts({ uniqueConstraints: [wider] })
      )
    ).toEqual([
      {
        type: "dropUniqueConstraint",
        tableName: "posts",
        constraintName: "sqlite_autoindex_posts_2",
      },
      { type: "addUniqueConstraint", tableName: "posts", constraint: wider },
    ]);
  });

  it("still sees a constraint the schema dropped", async () => {
    expect(
      await byShape(posts({ uniqueConstraints: [read] }), posts({}))
    ).toEqual([
      {
        type: "dropUniqueConstraint",
        tableName: "posts",
        constraintName: "sqlite_autoindex_posts_2",
      },
    ]);
  });

  it("column ORDER is part of the shape", async () => {
    // `UNIQUE (a, b)` and `UNIQUE (b, a)` index different prefixes, so they are
    // different constraints even though they forbid the same duplicates.
    const ab = { name: "sqlite_autoindex_posts_2", columns: ["a", "b"] };
    const ba = { name: "posts_b_a_key", columns: ["b", "a"] };

    expect(
      await byShape(
        posts({ uniqueConstraints: [ab] }),
        posts({ uniqueConstraints: [ba] })
      )
    ).toHaveLength(2);
  });
});

// --- The live push ----------------------------------------------------------

const quietUser = s
  .model({
    id: s.string().id(),
    posts: s.oneToMany(() => quietPost),
  })
  .map("quiet_users");

const quietPost = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    slug: s.string(),
    tenant: s.string(),
    author: s
      .manyToOne(() => quietUser)
      .fields("authorId")
      .references("id"),
  })
  .unique(["slug", "tenant"])
  .map("quiet_posts");

describe("SQLite push of an unchanged schema", () => {
  it("plans nothing from the second push on", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: { quietUser, quietPost } as never,
      driver,
    }) as never;

    // Push #1 creates. Pushes #2 and #3 must plan NOTHING: before the fix #2
    // planned dropForeignKey + dropUniqueConstraint + addUniqueConstraint +
    // addForeignKey, and the unique drop aborted the whole push.
    const planned: DiffOperation[][] = [];
    for (let round = 0; round < 3; round++) {
      const result = await push(client, { force: true });
      planned.push(result.operations);
    }

    expect(planned[1]).toEqual([]);
    expect(planned[2]).toEqual([]);

    // And the table still holds exactly what it was declared with — one FK,
    // one unique, one FK index — rather than having been rebuilt around a
    // synthesised name.
    const read = (await driver._executeRaw(
      "PRAGMA foreign_key_list(quiet_posts)"
    )) as unknown as { rows: unknown[] };
    expect(read.rows).toHaveLength(1);

    const master = (await driver._executeRaw(
      "SELECT sql FROM sqlite_master WHERE name = 'quiet_posts'"
    )) as unknown as { rows: Array<{ sql: string }> };
    expect(master.rows[0]?.sql).toContain(
      'CONSTRAINT "quiet_posts_slug_tenant_key" UNIQUE'
    );
    expect(master.rows[0]?.sql).toContain(
      'CONSTRAINT "quiet_posts_authorId_fkey" FOREIGN KEY'
    );
  });
});
