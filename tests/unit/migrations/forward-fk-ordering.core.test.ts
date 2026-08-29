/**
 * Forward-reference foreign-key DDL ordering.
 *
 * REGRESSION: push() applied a schema's DDL in model DECLARATION order with no
 * topological sort, emitting each table's foreign keys inline (MySQL) or as an
 * `ALTER TABLE ... ADD CONSTRAINT` bundled immediately after its `CREATE TABLE`
 * (Postgres). A model A holding a `manyToOne` FK to a model B declared AFTER A
 * therefore emitted the FK before `CREATE TABLE B` existed -> Postgres 42P01
 * (undefined_table), MySQL analogous; the whole transactional push aborted with
 * zero tables created. SQLite/LibSQL were immune (inline FK + lazy resolution).
 *
 * FIX: `extractForwardReferenceForeignKeys` lifts a new table's *forward*-
 * reference FKs into separate `addForeignKey` operations (Postgres/MySQL only),
 * so every referenced table is created before its constraint is added. It is a
 * no-op for SQLite/LibSQL (they cannot `ALTER TABLE ADD FOREIGN KEY` and keep
 * FKs inline) and for referenced-first / self-reference schemas (byte-stable).
 *
 * This file is the driver-agnostic witness (operation transform + emitted DDL
 * ordering). The five-driver live push + round-trip lives in
 * `tests/drivers/forward-fk-ordering-behavior.ts`.
 */

import { createClient } from "@client/client";
import { applyV1 as apply } from "@migrations/apply-v1";
import { generateV1 as generate } from "@migrations/generate-v1";
import { s } from "@schema";
import type { MigrationDriver } from "@src/migrations/drivers";
import { libsqlMigrationDriver } from "@src/migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import type { DiffOperation, ForeignKeyDef } from "@src/migrations/types";
import { extractForwardReferenceForeignKeys } from "@src/migrations/utils";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { ddlContextFor, MemoryStorage } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

const CREATE_TABLE_RE = /CREATE TABLE/i;
const FOREIGN_KEY_RE = /FOREIGN KEY/i;
const ALTER_ADD_FK_RE = /ALTER TABLE .* FOREIGN KEY/i;

function fk(
  name: string,
  column: string,
  referencedTable: string
): ForeignKeyDef {
  return {
    name,
    columns: [column],
    referencedTable,
    referencedColumns: ["id"],
    onDelete: "restrict",
    onUpdate: "noAction",
  };
}

function createTable(
  name: string,
  foreignKeys: ForeignKeyDef[] = []
): DiffOperation {
  return {
    type: "createTable",
    table: {
      name,
      columns: [
        { name: "id", type: "text", nullable: false },
        ...foreignKeys.map((f) => ({
          name: f.columns[0]!,
          type: "text",
          nullable: false,
        })),
      ],
      indexes: [],
      foreignKeys,
      uniqueConstraints: [],
    },
  };
}

// post (declared first) -> user (declared later): a forward reference.
const FORWARD_REF_OPS: DiffOperation[] = [
  createTable("post", [fk("post_author_fkey", "authorId", "user")]),
  createTable("user"),
];

// user (declared first), post (later) -> user: a backward reference.
const REFERENCED_FIRST_OPS: DiffOperation[] = [
  createTable("user"),
  createTable("post", [fk("post_author_fkey", "authorId", "user")]),
];

function opTypes(ops: DiffOperation[]): string[] {
  return ops.map((o) => o.type);
}

function createdTableFkCount(ops: DiffOperation[]): number {
  return ops
    .filter(
      (o): o is Extract<DiffOperation, { type: "createTable" }> =>
        o.type === "createTable"
    )
    .reduce((sum, o) => sum + o.table.foreignKeys.length, 0);
}

describe("extractForwardReferenceForeignKeys — capability gating", () => {
  const inlineDrivers: [string, MigrationDriver][] = [
    ["sqlite", sqlite3MigrationDriver],
    ["libsql", libsqlMigrationDriver],
  ];

  for (const [name, driver] of inlineDrivers) {
    it(`${name}: keeps FKs inline (returns input unchanged)`, () => {
      expect(driver.capabilities.supportsAddForeignKeyViaAlter).toBe(false);
      const out = extractForwardReferenceForeignKeys(FORWARD_REF_OPS, driver);
      // Same operations, same order, FK still on the createTable — no lifting.
      expect(out).toEqual(FORWARD_REF_OPS);
      expect(opTypes(out)).toEqual(["createTable", "createTable"]);
      expect(createdTableFkCount(out)).toBe(1);
    });
  }

  const alterDrivers: [string, MigrationDriver][] = [
    ["postgres", postgresMigrationDriver],
    ["mysql", mysqlMigrationDriver],
  ];

  for (const [name, driver] of alterDrivers) {
    it(`${name}: lifts a forward-ref FK into a trailing addForeignKey op`, () => {
      expect(driver.capabilities.supportsAddForeignKeyViaAlter).toBe(true);
      const out = extractForwardReferenceForeignKeys(FORWARD_REF_OPS, driver);

      // All CREATE TABLE ops precede any ADD FOREIGN KEY op.
      expect(opTypes(out)).toEqual([
        "createTable",
        "createTable",
        "addForeignKey",
      ]);
      // The FK is no longer inline on the createTable.
      expect(createdTableFkCount(out)).toBe(0);
      const added = out.find((o) => o.type === "addForeignKey");
      expect(added).toMatchObject({
        type: "addForeignKey",
        tableName: "post",
        fk: { name: "post_author_fkey", referencedTable: "user" },
      });
    });

    it(`${name}: referenced-first schema is left byte-identical (no lifting)`, () => {
      const out = extractForwardReferenceForeignKeys(
        REFERENCED_FIRST_OPS,
        driver
      );
      expect(out).toEqual(REFERENCED_FIRST_OPS);
      expect(createdTableFkCount(out)).toBe(1);
    });

    it(`${name}: a self-reference stays inline (not a forward ref)`, () => {
      const selfRef: DiffOperation[] = [
        createTable("node", [fk("node_parent_fkey", "parentId", "node")]),
      ];
      const out = extractForwardReferenceForeignKeys(selfRef, driver);
      expect(out).toEqual(selfRef);
      expect(createdTableFkCount(out)).toBe(1);
    });

    it(`${name}: FK to a pre-existing (not-created) table stays inline`, () => {
      // "user" is not in the createTable set (already exists in the DB).
      const ops: DiffOperation[] = [
        createTable("post", [fk("post_author_fkey", "authorId", "user")]),
      ];
      const out = extractForwardReferenceForeignKeys(ops, driver);
      expect(out).toEqual(ops);
      expect(createdTableFkCount(out)).toBe(1);
    });

    it(`${name}: multi-model forward chain lifts every forward edge`, () => {
      // a -> b -> c -> d, all declared parent-last (every edge forward).
      const chain: DiffOperation[] = [
        createTable("a", [fk("a_b_fkey", "bId", "b")]),
        createTable("b", [fk("b_c_fkey", "cId", "c")]),
        createTable("c", [fk("c_d_fkey", "dId", "d")]),
        createTable("d"),
      ];
      const out = extractForwardReferenceForeignKeys(chain, driver);
      expect(opTypes(out)).toEqual([
        "createTable",
        "createTable",
        "createTable",
        "createTable",
        "addForeignKey",
        "addForeignKey",
        "addForeignKey",
      ]);
      expect(createdTableFkCount(out)).toBe(0);
    });

    it(`${name}: a 2-cycle lifts only the forward edge, keeps the backward one inline`, () => {
      // a (first) -> b, b (second) -> a. a->b is forward, b->a is backward.
      const cycle: DiffOperation[] = [
        createTable("a", [fk("a_b_fkey", "bId", "b")]),
        createTable("b", [fk("b_a_fkey", "aId", "a")]),
      ];
      const out = extractForwardReferenceForeignKeys(cycle, driver);
      expect(opTypes(out)).toEqual([
        "createTable",
        "createTable",
        "addForeignKey",
      ]);
      // b->a remains inline on b's createTable; a->b was lifted.
      expect(createdTableFkCount(out)).toBe(1);
      const bCreate = out.find(
        (o) => o.type === "createTable" && o.table.name === "b"
      );
      expect(
        bCreate?.type === "createTable" &&
          bCreate.table.foreignKeys.map((f) => f.name)
      ).toEqual(["b_a_fkey"]);
      const added = out.find((o) => o.type === "addForeignKey");
      expect(added).toMatchObject({ tableName: "a" });
    });
  }
});

describe("emitted DDL ordering (forward-ref schema)", () => {
  function ddlFor(driver: MigrationDriver): string[] {
    const ops = extractForwardReferenceForeignKeys(FORWARD_REF_OPS, driver);
    const statements: string[] = [];
    for (const op of ops) {
      const ddl = driver.generateDDL(
        op,
        ddlContextFor("artifact", { tables: [] })
      );
      statements.push(...ddl.split(";\n").filter((s) => s.trim()));
    }
    return statements;
  }

  for (const driver of [postgresMigrationDriver, mysqlMigrationDriver]) {
    it(`${driver.dialect}: every CREATE TABLE precedes every ADD ... FOREIGN KEY`, () => {
      const statements = ddlFor(driver);
      const lastCreate = statements.reduce(
        (idx, s, i) => (CREATE_TABLE_RE.test(s) ? i : idx),
        -1
      );
      const firstAlterFk = statements.findIndex((s) => ALTER_ADD_FK_RE.test(s));
      expect(lastCreate).toBeGreaterThanOrEqual(0);
      expect(firstAlterFk).toBeGreaterThanOrEqual(0);
      expect(lastCreate).toBeLessThan(firstAlterFk);
      // And no CREATE TABLE carries an inline FOREIGN KEY clause.
      const createWithInlineFk = statements.find(
        (s) => CREATE_TABLE_RE.test(s) && FOREIGN_KEY_RE.test(s)
      );
      expect(createWithInlineFk).toBeUndefined();
    });
  }

  it("sqlite: keeps the FK inline in CREATE TABLE (no separate ADD)", () => {
    const statements = ddlFor(sqlite3MigrationDriver);
    const createWithInlineFk = statements.find(
      (s) => CREATE_TABLE_RE.test(s) && FOREIGN_KEY_RE.test(s)
    );
    expect(createWithInlineFk).toBeDefined();
    const alterAddFk = statements.find((s) => ALTER_ADD_FK_RE.test(s));
    expect(alterAddFk).toBeUndefined();
  });
});

// The generated-migration-file path shares the differ with push(); it must
// order the same way. This exercises generate() end to end (SQL + apply) on a
// forward-ref schema.
describe("generate() migration file — forward-ref ordering", () => {
  const forwardRefSchema = (() => {
    const post = s.model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const user = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    });
    return { post, user };
  })();

  it("emits every CREATE TABLE before any ADD ... FOREIGN KEY, and applies", async () => {
    const storage = new MemoryStorage();
    const client = createClient({
      schema: forwardRefSchema as never,
      driver: createInMemoryPGliteDriver(),
    });

    const gen = await generate(client as never, storage, { name: "init" });

    expect(gen.outcome).toBe("published");
    expect(gen.stateId).not.toBeNull();
    const lastCreate = gen.sql.lastIndexOf("CREATE TABLE");
    const firstAlterFk = gen.sql.search(ALTER_ADD_FK_RE);
    expect(lastCreate).toBeGreaterThanOrEqual(0);
    expect(firstAlterFk).toBeGreaterThanOrEqual(0);
    expect(lastCreate).toBeLessThan(firstAlterFk);

    // The generated migration applies cleanly and round-trips.
    const applied = await apply(client as never, storage);
    expect(applied.outcome).toBe("applied");
    expect(applied.path).toHaveLength(1);

    const c = client as never as Record<string, any>;
    await c.user.create({ data: { id: "u1", name: "Ann" } });
    await c.post.create({ data: { id: "p1", title: "T", authorId: "u1" } });
    const posts = await c.post.findMany({ include: { author: true } });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.author?.id).toBe("u1");

    await (
      client as never as { $disconnect: () => Promise<void> }
    ).$disconnect();
  });
});
