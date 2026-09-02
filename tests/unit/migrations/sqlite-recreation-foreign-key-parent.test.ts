/**
 * A SQLite table recreation of a table another table's foreign key points at.
 *
 * SQLite cannot alter a table in place, so `alterColumn`, `addForeignKey`,
 * `addUniqueConstraint` and `dropUniqueConstraint` all go through
 * `generateTableRecreation`: create `__new_<t>`, copy, `DROP TABLE <t>`,
 * rename. `DROP TABLE` is the step that needs foreign keys really disabled —
 * with enforcement on, SQLite performs an implicit `DELETE FROM` first, which
 * either raises the constraint or fires the referential action on the children.
 *
 * MEASURED on better-sqlite3 at `5e5bc60`, with a populated parent and one
 * child row. `executeDDLStatements` runs the whole batch inside
 * `driver.withTransaction`, and `PRAGMA foreign_keys=OFF` is documented by
 * SQLite as a NO-OP inside a transaction, so the recreation ran with
 * enforcement still on:
 *
 *   - NO ACTION   -> `DROP TABLE "…"` threw `FOREIGN KEY constraint failed`;
 *                    the push applied nothing.
 *   - SET NULL    -> threw `NOT NULL constraint failed`.
 *   - CASCADE     -> did NOT throw. The implicit `DELETE FROM` cascade-deleted
 *                    every child row and the push reported success. Silent
 *                    data loss, which is the worse half of the same defect.
 *
 * `PRAGMA defer_foreign_keys=ON`, the spelling SQLite does honor inside a
 * transaction, does not close it either: it only defers the violation counter
 * that the implicit delete already incremented, so NO ACTION moves its failure
 * from `DROP TABLE` to `COMMIT`, and CASCADE still loses the children.
 *
 * FIX: the pragma is hoisted out of the transaction — SQLite's own documented
 * procedure has step 1 (`PRAGMA foreign_keys=OFF`) precede step 2 (`BEGIN`).
 * See `liftForeignKeyPragmas` in `src/migrations/foreign-keys.ts`.
 *
 * This file is the witness the unique-constraint work lacked:
 * `sqlite-unique-constraint.test.ts` recreates `uq_posts`, which holds a
 * foreign key but is not pointed at by one, so it never reached `DROP TABLE`
 * on a referenced parent.
 */

import { createClient } from "@client/client";
import { VibORMErrorCode } from "@errors";
import { applyV1 as apply } from "@migrations/apply-v1";
import { generateV1 as generate } from "@migrations/generate-v1";
import { downV1 as down } from "@migrations/operators";
import { s } from "@schema";
import type { SQLite3Driver } from "@src/drivers/sqlite3";
import { createInMemoryLibSQLDriver } from "@tests/fixtures/drivers/libsql";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";
import { MemoryStorage } from "./_estate";

type RawDriver = { _executeRaw: SQLite3Driver["_executeRaw"] };

type Action = "noAction" | "cascade" | "setNull";

/**
 * `fk_parent` is the recreation target; `fk_kid` is what makes `DROP TABLE`
 * refuse. `widen` swaps the parent's `width` column type so the same fixture
 * can also drive `alterColumn`, the pre-existing half of the hazard.
 */
function buildSchema(
  action: Action,
  opts: { unique: boolean; widen: boolean }
) {
  const parentFields = {
    id: s.string().id(),
    a: s.string(),
    b: s.string(),
    width: opts.widen ? s.int() : s.string(),
    kids: s.toMany(() => kid),
  };

  const parentBase = s.model(parentFields);
  const parent = (opts.unique ? parentBase.unique(["a", "b"]) : parentBase).map(
    "fk_parent"
  );

  const kid = s
    .model({
      id: s.string().id(),
      parentId: action === "setNull" ? s.string().nullable() : s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id")
        .onDelete(action),
    })
    .map("fk_kid");

  return { parent, kid };
}

async function seed(driver: RawDriver) {
  await driver._executeRaw(
    `INSERT INTO "fk_parent" ("id", "a", "b", "width") VALUES ('p1', 'x', 'y', '10')`
  );
  await driver._executeRaw(
    `INSERT INTO "fk_kid" ("id", "parentId") VALUES ('k1', 'p1')`
  );
}

async function rows(driver: RawDriver, sql: string) {
  const result = (await driver._executeRaw(sql)) as unknown as {
    rows: Record<string, unknown>[];
  };
  return result.rows;
}

async function createTableSql(driver: RawDriver, table: string) {
  const found = await rows(
    driver,
    `SELECT sql FROM sqlite_master WHERE name = '${table}'`
  );
  return (found[0]?.sql as string) ?? "";
}

const ACTIONS: Action[] = ["noAction", "cascade", "setNull"];

const MATCH_BROKEN_REFERENCE_REFUSAL = /violating a foreign key/;

describe("recreating a SQLite table a foreign key points at", () => {
  for (const action of ACTIONS) {
    it(`adds a unique constraint under onDelete ${action} without touching the children`, async () => {
      const driver = createInMemorySQLite3Driver();
      const plain = buildSchema(action, { unique: false, widen: false });
      const uniqued = buildSchema(action, { unique: true, widen: false });

      await syncLiveSchema(
        createClient({ schema: plain as never, driver }) as never
      );
      await seed(driver);

      const planned = (
        await syncLiveSchema(
          createClient({ schema: uniqued as never, driver }) as never
        )
      ).operations.map((op) => op.label);
      expect(planned).toEqual(["addUniqueConstraint"]);

      // The constraint landed inline, so SQLite reads it back as a constraint.
      expect(await createTableSql(driver, "fk_parent")).toContain(
        'CONSTRAINT "fk_parent_a_b_key" UNIQUE ("a", "b")'
      );

      // Neither side lost a row. Under `cascade` this is the assertion that
      // fails when the recreation runs with enforcement on.
      expect(await rows(driver, `SELECT "id" FROM "fk_parent"`)).toEqual([
        { id: "p1" },
      ]);
      expect(
        await rows(driver, `SELECT "id", "parentId" FROM "fk_kid"`)
      ).toEqual([{ id: "k1", parentId: "p1" }]);

      // The constraint is enforced, and so is the foreign key it was rebuilt
      // around — the pragma was restored.
      await expect(
        driver._executeRaw(
          `INSERT INTO "fk_parent" ("id", "a", "b", "width") VALUES ('p2', 'x', 'y', '1')`
        )
      ).rejects.toThrow();
      await expect(
        driver._executeRaw(
          `INSERT INTO "fk_kid" ("id", "parentId") VALUES ('k9', 'nope')`
        )
      ).rejects.toThrow();
    });
  }

  it("alters a column on a referenced parent — the half that predates the unique work", async () => {
    const driver = createInMemorySQLite3Driver();
    const narrow = buildSchema("noAction", { unique: false, widen: false });
    const wide = buildSchema("noAction", { unique: false, widen: true });

    await syncLiveSchema(
      createClient({ schema: narrow as never, driver }) as never
    );
    await seed(driver);

    const planned = (
      await syncLiveSchema(
        createClient({ schema: wide as never, driver }) as never
      )
    ).operations.map((op) => op.label);
    expect(planned).toEqual(["alterColumn"]);

    expect(await rows(driver, `SELECT "id", "width" FROM "fk_parent"`)).toEqual(
      [{ id: "p1", width: 10 }]
    );
    expect(await rows(driver, `SELECT "id", "parentId" FROM "fk_kid"`)).toEqual(
      [{ id: "k1", parentId: "p1" }]
    );
  });

  it("drops a unique constraint from a referenced parent", async () => {
    const driver = createInMemorySQLite3Driver();
    const uniqued = buildSchema("noAction", { unique: true, widen: false });
    const plain = buildSchema("noAction", { unique: false, widen: false });

    await syncLiveSchema(
      createClient({ schema: uniqued as never, driver }) as never
    );
    await seed(driver);

    const planned = (
      await syncLiveSchema(
        createClient({ schema: plain as never, driver }) as never
      )
    ).operations.map((op) => op.label);
    expect(planned).toEqual(["dropUniqueConstraint"]);

    expect(await createTableSql(driver, "fk_parent")).not.toContain("UNIQUE");
    expect(await rows(driver, `SELECT "id", "parentId" FROM "fk_kid"`)).toEqual(
      [{ id: "k1", parentId: "p1" }]
    );
  });

  it("leaves foreign keys enforced when the batch holds no recreation", async () => {
    const driver = createInMemorySQLite3Driver();
    const plain = buildSchema("noAction", { unique: false, widen: false });

    await syncLiveSchema(
      createClient({ schema: plain as never, driver }) as never
    );

    await expect(
      driver._executeRaw(
        `INSERT INTO "fk_kid" ("id", "parentId") VALUES ('k9', 'nope')`
      )
    ).rejects.toThrow();
  });
});

/**
 * Lifting the pragma is what makes the disable real, and a real disable is
 * fail-open for everything else in the batch. `PRAGMA foreign_key_check` —
 * step 10 of SQLite's recreation procedure — is that hole closed, and it runs
 * before `COMMIT` so a violation takes the whole batch back.
 *
 * It cannot tell a reference the batch broke from one it merely found, and
 * refuses either way. That is the fail-closed reading: SQLite's own procedure
 * says a reported violation means the schema change is to be abandoned.
 */
describe("a lifted batch that would commit against a broken reference", () => {
  it("is refused, and the push applies nothing", async () => {
    const driver = createInMemorySQLite3Driver();
    const plain = buildSchema("noAction", { unique: false, widen: false });
    const uniqued = buildSchema("noAction", { unique: true, widen: false });

    await syncLiveSchema(
      createClient({ schema: plain as never, driver }) as never
    );
    await seed(driver);

    // An orphan only reachable with enforcement off — the state a `dropTable`
    // sharing a lifted batch would otherwise leave behind.
    await driver._executeRaw("PRAGMA foreign_keys=OFF;");
    await driver._executeRaw(
      `INSERT INTO "fk_kid" ("id", "parentId") VALUES ('k2', 'ghost')`
    );
    await driver._executeRaw("PRAGMA foreign_keys=ON;");

    await expect(
      syncLiveSchema(
        createClient({ schema: uniqued as never, driver }) as never
      )
    ).rejects.toThrow(MATCH_BROKEN_REFERENCE_REFUSAL);

    // Rolled back: no constraint, and enforcement is back on.
    expect(await createTableSql(driver, "fk_parent")).not.toContain("UNIQUE");
    await expect(
      driver._executeRaw(
        `INSERT INTO "fk_kid" ("id", "parentId") VALUES ('k9', 'nope')`
      )
    ).rejects.toThrow();
  });
});

describe("applying a generated migration that recreates a referenced parent", () => {
  it("keeps the children, under the referential action that loses them silently", async () => {
    const storage = new MemoryStorage();
    const driver = createInMemorySQLite3Driver();
    const plain = buildSchema("cascade", { unique: false, widen: false });
    const uniqued = buildSchema("cascade", { unique: true, widen: false });

    const v1 = createClient({ schema: plain as never, driver }) as never;
    await generate(v1, storage, { name: "init" });
    await apply(v1, storage);
    await seed(driver);

    const v2 = createClient({ schema: uniqued as never, driver }) as never;
    const generated = await generate(v2, storage, { name: "unique" });
    // The file really does carry the pragma the transaction would swallow.
    expect(generated.sql).toContain("PRAGMA foreign_keys=OFF");

    await apply(v2, storage);

    expect(await rows(driver, `SELECT "id", "parentId" FROM "fk_kid"`)).toEqual(
      [{ id: "k1", parentId: "p1" }]
    );
    expect(await createTableSql(driver, "fk_parent")).toContain(
      'CONSTRAINT "fk_parent_a_b_key" UNIQUE ("a", "b")'
    );

    // The rollback undoes a recreation with a recreation, inside one
    // transaction of its own — the same bracket, at a third seam.
    await down(v2, storage, { steps: 1 });

    expect(await createTableSql(driver, "fk_parent")).not.toContain("UNIQUE");
    expect(await rows(driver, `SELECT "id", "parentId" FROM "fk_kid"`)).toEqual(
      [{ id: "k1", parentId: "p1" }]
    );
  });
});

describe("LibSQL refuses effectful live sync", () => {
  it("refuses DRIVER_NOT_SUPPORTED instead of recreating a referenced parent", async () => {
    const driver = createInMemoryLibSQLDriver();
    const plain = buildSchema("cascade", { unique: false, widen: false });

    await expect(
      syncLiveSchema(createClient({ schema: plain as never, driver }) as never)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
  });
});
