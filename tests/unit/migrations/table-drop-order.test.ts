/**
 * Issue #42 on a live SQLite3 database: removing populated tables that still
 * reference each other.
 *
 * SQLite enforces foreign keys while it drops a table: `DROP TABLE` first runs
 * an implicit `DELETE FROM`, so a parent dropped while a populated child still
 * references it is refused. Before the fix, `aaa_parent` / `zzz_child` failed
 * with `ForeignKeyError: Foreign key constraint violation` and
 * `zzz_parent` / `aaa_child` succeeded: the plan followed catalog order.
 * `orderTableDrops` (`src/migrations/drop-order.ts`) now orders drops from the
 * foreign keys the database holds.
 *
 * Every cell enters through the public migration client, with foreign-key
 * enforcement on (the SQLite3 driver turns it on) and restrictive references
 * populated. The program-shape contracts are `table-drop-order.core.test.ts`.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { ResolveCallback } from "@src/migrations/types";
import type { AnyModel } from "@src/schema/model";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, test } from "vitest";

type Schema = Record<string, AnyModel>;
type Driver = ReturnType<typeof createInMemorySQLite3Driver>;

const DROP_TABLE = /^DROP TABLE "([^"]+)"$/;

const proceed: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : change.reject();

function migrationsFor(driver: Driver, schema: Schema) {
  return createMigrationClient(createClient({ schema, driver }));
}

/** Preview with the exact destructive consent, then apply that consent. */
async function pushDestructive(
  driver: Driver,
  schema: Schema,
  resolve: ResolveCallback = proceed
) {
  const migrations = migrationsFor(driver, schema);
  const preview = await migrations.push({ dryRun: true, resolve });
  const applied = await migrations.push({ consent: preview.consent });
  return { preview, applied };
}

async function rows(driver: Driver, sql: string) {
  return (await driver._executeRaw<Record<string, unknown>>(sql)).rows;
}

async function tables(driver: Driver) {
  return (
    await rows(
      driver,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
  ).map((row) => String(row.name));
}

async function count(driver: Driver, table: string) {
  return (await rows(driver, `SELECT COUNT(*) AS n FROM "${table}"`))[0]?.n;
}

function droppedIn(statements: readonly { readonly sql: string }[]) {
  return statements.flatMap(({ sql }) => {
    const match = DROP_TABLE.exec(sql);
    return match?.[1] ? [match[1]] : [];
  });
}

function parentAndChild(parentName: string, childName: string) {
  const parent = s
    .model({ id: s.string().id(), children: s.toMany(() => child) })
    .map(parentName);
  const child = s
    .model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id")
        .onDelete("restrict"),
    })
    .map(childName);
  return { parent, child };
}

async function seedPair(driver: Driver, parentName: string, childName: string) {
  await driver._executeRaw(`INSERT INTO "${parentName}" ("id") VALUES ('p1')`);
  await driver._executeRaw(
    `INSERT INTO "${childName}" ("id", "parentId") VALUES ('c1', 'p1')`
  );
}

describe("both lexical orientations remove a populated parent and child", () => {
  for (const [parentName, childName] of [
    ["aaa_parent", "zzz_child"],
    ["zzz_parent", "aaa_child"],
  ] as const) {
    test(`${parentName} / ${childName}`, async () => {
      const driver = createInMemorySQLite3Driver();
      await migrationsFor(driver, parentAndChild(parentName, childName)).push();
      await seedPair(driver, parentName, childName);

      const { preview, applied } = await pushDestructive(driver, {});

      expect(droppedIn(preview.statements)).toEqual([childName, parentName]);
      // What was shown, what the consent signed and what ran are one program.
      expect(applied.outcome).toBe("applied");
      expect(applied.planHash).toBe(preview.planHash);
      expect(applied.statements).toEqual(preview.statements);
      expect(await tables(driver)).toEqual([]);
      await driver.disconnect();
    });
  }
});

test("a failure after the drops rolls every drop back", async () => {
  const driver = createInMemorySQLite3Driver();
  const keeper = s.model({ id: s.string().id(), code: s.string() });
  await migrationsFor(driver, {
    ...parentAndChild("aaa_parent", "zzz_child"),
    keeper,
  }).push();
  await seedPair(driver, "aaa_parent", "zzz_child");
  await driver._executeRaw(
    `INSERT INTO "keeper" ("id", "code") VALUES ('k1', 'same'), ('k2', 'same')`
  );

  // A unique index over duplicate values fails AFTER both drops ran.
  const migrations = migrationsFor(driver, {
    keeper: keeper.index(["code"], { unique: true }),
  });
  const preview = await migrations.push({ dryRun: true, resolve: proceed });
  const order = preview.statements.map(({ sql }) => sql);
  expect(droppedIn(preview.statements)).toEqual(["zzz_child", "aaa_parent"]);
  expect(
    order.findIndex((sql) => sql.startsWith("CREATE UNIQUE INDEX"))
  ).toBeGreaterThan(order.indexOf('DROP TABLE "aaa_parent"'));

  await expect(migrations.push({ consent: preview.consent })).rejects.toThrow();
  expect(await tables(driver)).toEqual(["aaa_parent", "keeper", "zzz_child"]);
  expect(await count(driver, "aaa_parent")).toBe(1);
  expect(await count(driver, "zzz_child")).toBe(1);
  expect(await count(driver, "keeper")).toBe(2);
  await driver.disconnect();
});

describe("dependency shapes", () => {
  test("a three-level chain with two keys between one pair drops in one push", async () => {
    const root = s
      .model({ id: s.string().id(), mids: s.toMany(() => mid) })
      .map("a_root");
    const mid = s
      .model({
        id: s.string().id(),
        rootId: s.string(),
        root: s
          .toOne(() => root)
          .fields("rootId")
          .references("id")
          .onDelete("restrict"),
        leftLeaves: s.toMany(() => leaf).name("west"),
        rightLeaves: s.toMany(() => leaf).name("east"),
      })
      .map("b_mid");
    const leaf = s
      .model({
        id: s.string().id(),
        westId: s.string(),
        eastId: s.string(),
        west: s
          .toOne(() => mid)
          .name("west")
          .fields("westId")
          .references("id")
          .onDelete("restrict"),
        east: s
          .toOne(() => mid)
          .name("east")
          .fields("eastId")
          .references("id")
          .onDelete("restrict"),
      })
      .map("c_leaf");
    const driver = createInMemorySQLite3Driver();
    await migrationsFor(driver, { root, mid, leaf }).push();
    await driver._executeRaw(`INSERT INTO "a_root" ("id") VALUES ('r')`);
    await driver._executeRaw(
      `INSERT INTO "b_mid" ("id", "rootId") VALUES ('m', 'r')`
    );
    await driver._executeRaw(
      `INSERT INTO "c_leaf" ("id", "westId", "eastId") VALUES ('l', 'm', 'm')`
    );

    const { preview, applied } = await pushDestructive(driver, {});
    expect(droppedIn(preview.statements)).toEqual([
      "c_leaf",
      "b_mid",
      "a_root",
    ]);
    expect(applied.outcome).toBe("applied");
    expect(await tables(driver)).toEqual([]);
    await driver.disconnect();
  });

  test("a populated implicit junction goes before both of its endpoints", async () => {
    const post = s.model({ id: s.string().id(), tags: s.toMany(() => tag) });
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: { post, tag }, driver });
    await createMigrationClient(client).push();
    await client.post.create({
      data: { id: "p", tags: { create: [{ id: "t" }] } },
    });
    const [junction] = (await tables(driver)).filter(
      (name) => name !== "post" && name !== "tag"
    );
    expect(await count(driver, String(junction))).toBe(1);

    const { preview, applied } = await pushDestructive(driver, {});
    expect(droppedIn(preview.statements)[0]).toBe(junction);
    expect(applied.outcome).toBe("applied");
    expect(await tables(driver)).toEqual([]);
    await driver.disconnect();
  });
});

describe("tables that survive", () => {
  test("a retained child whose key is removed keeps its rows while its parent goes", async () => {
    const driver = createInMemorySQLite3Driver();
    await migrationsFor(
      driver,
      parentAndChild("aaa_parent", "zzz_child")
    ).push();
    await seedPair(driver, "aaa_parent", "zzz_child");
    const orphan = s
      .model({ id: s.string().id(), parentId: s.string() })
      .map("zzz_child");

    const { applied } = await pushDestructive(driver, { child: orphan });
    expect(applied.outcome).toBe("applied");
    expect(await tables(driver)).toEqual(["zzz_child"]);
    expect(await rows(driver, `SELECT * FROM "zzz_child"`)).toEqual([
      { id: "c1", parentId: "p1" },
    ]);
    await driver.disconnect();
  });

  test("a retained child with its key keeps every row while unrelated tables go", async () => {
    const pair = parentAndChild("m_parent", "n_child");
    const audit = s
      .model({ id: s.string().id(), entries: s.toMany(() => entry) })
      .map("a_audit");
    const entry = s
      .model({
        id: s.string().id(),
        auditId: s.string(),
        audit: s
          .toOne(() => audit)
          .fields("auditId")
          .references("id")
          .onDelete("restrict"),
      })
      .map("z_entry");
    const driver = createInMemorySQLite3Driver();
    await migrationsFor(driver, { ...pair, audit, entry }).push();
    await seedPair(driver, "m_parent", "n_child");
    await driver._executeRaw(`INSERT INTO "a_audit" ("id") VALUES ('a')`);
    await driver._executeRaw(
      `INSERT INTO "z_entry" ("id", "auditId") VALUES ('e', 'a')`
    );

    const { preview, applied } = await pushDestructive(driver, pair);
    expect(droppedIn(preview.statements)).toEqual(["z_entry", "a_audit"]);
    expect(applied.outcome).toBe("applied");
    expect(await tables(driver)).toEqual(["m_parent", "n_child"]);
    expect(await count(driver, "m_parent")).toBe(1);
    expect(await count(driver, "n_child")).toBe(1);
    await driver.disconnect();
  });

  test("a rename, a create and a rebuild share the program with the ordered drops", async () => {
    const kept = s.model({ id: s.string().id(), size: s.string() });
    const driver = createInMemorySQLite3Driver();
    await migrationsFor(driver, {
      ...parentAndChild("aaa_parent", "zzz_child"),
      kept: kept.map("old_kept"),
    }).push();
    await seedPair(driver, "aaa_parent", "zzz_child");
    await driver._executeRaw(
      `INSERT INTO "old_kept" ("id", "size") VALUES ('k', '7')`
    );

    const fresh = s.model({ id: s.string().id() });
    const widened = s.model({ id: s.string().id(), size: s.int() });
    const renameQuestions: string[] = [];
    const { preview, applied } = await pushDestructive(
      driver,
      { kept: widened.map("new_kept"), fresh },
      (change) => {
        if (change.type === "ambiguous") {
          renameQuestions.push(`${change.oldName}->${change.newName}`);
          if (change.oldName === "old_kept")
            return change.newName === "new_kept"
              ? change.rename()
              : change.reject();
          return change.addAndDrop();
        }
        return change.type === "destructive"
          ? change.proceed()
          : change.reject();
      }
    );
    // The rebuild's own `DROP TABLE` of its source runs later, inside it.
    expect(droppedIn(preview.statements).slice(0, 2)).toEqual([
      "zzz_child",
      "aaa_parent",
    ]);
    expect(applied.outcome).toBe("applied");
    expect(renameQuestions).toContain("old_kept->new_kept");
    expect(await tables(driver)).toEqual(["fresh", "new_kept"]);
    expect(await rows(driver, `SELECT * FROM "new_kept"`)).toEqual([
      { id: "k", size: 7 },
    ]);
    expect(await rows(driver, `SELECT * FROM "fresh"`)).toEqual([]);
    await driver.disconnect();
  });
});

type DeleteAction = "cascade" | "setNull" | "restrict" | "noAction";

/**
 * `z_west.eastId` references `a_east` under `pick`; `a_east.westId`
 * references `z_west` under `back`. Catalog order puts `a_east` first.
 */
function cycle(pick: DeleteAction, back: DeleteAction) {
  const west = s
    .model({
      id: s.string().id(),
      eastId: s.string().nullable(),
      east: s
        .toOne(() => east)
        .name("pick")
        .fields("eastId")
        .references("id")
        .onDelete(pick),
      pickedBy: s.toMany(() => east).name("back"),
    })
    .map("z_west");
  const east = s
    .model({
      id: s.string().id(),
      westId: s.string().nullable(),
      west: s
        .toOne(() => west)
        .name("back")
        .fields("westId")
        .references("id")
        .onDelete(back),
      pickedBy: s.toMany(() => west).name("pick"),
    })
    .map("a_east");
  return { west, east };
}

/**
 * Three west rows and two east rows referencing each other. Deleting `w1`
 * first reaches `e2`, which `w3` still references: the rows a single-row
 * fixture would not have.
 */
async function seededCycle(pick: DeleteAction, back: DeleteAction) {
  const driver = createInMemorySQLite3Driver();
  await migrationsFor(driver, cycle(pick, back)).push();
  await driver._executeRaw(
    `INSERT INTO "z_west" ("id", "eastId") VALUES ('w1', NULL), ('w2', NULL), ('w3', NULL)`
  );
  await driver._executeRaw(
    `INSERT INTO "a_east" ("id", "westId") VALUES ('e1', 'w2'), ('e2', 'w1')`
  );
  await driver._executeRaw(
    `UPDATE "z_west" SET "eastId" = CASE "id" WHEN 'w3' THEN 'e2' ELSE 'e1' END`
  );
  return driver;
}

describe("a populated cycle drops when a delete action gives an order", () => {
  for (const [pick, back, order] of [
    ["setNull", "setNull", ["a_east", "z_west"]],
    ["cascade", "cascade", ["a_east", "z_west"]],
    // Dropping `a_east` first would leave west rows pointing at nothing;
    // dropping `z_west` cascades into `a_east`, and the NO ACTION rows that
    // point back are gone by the end of that statement.
    ["noAction", "cascade", ["z_west", "a_east"]],
  ] as const) {
    test(`z_west -> a_east ${pick}, a_east -> z_west ${back}`, async () => {
      const driver = await seededCycle(pick, back);
      const { preview, applied } = await pushDestructive(driver, {});
      expect(droppedIn(preview.statements)).toEqual(order);
      expect(applied.statements).toEqual(preview.statements);
      expect(applied.outcome).toBe("applied");
      expect(await tables(driver)).toEqual([]);
      await driver.disconnect();
    });
  }
});

describe("no order satisfies the keys", () => {
  for (const [pick, back, refusals] of [
    [
      "restrict",
      "restrict",
      'dropping "a_east" is refused by z_west(eastId) -> a_east ON DELETE RESTRICT; dropping "z_west" is refused by a_east(westId) -> z_west ON DELETE RESTRICT.',
    ],
    // Dropping `z_west` cascades into `a_east`: deleting `w1` removes `e2`,
    // which `w3` still references, and RESTRICT checks that at once.
    [
      "restrict",
      "cascade",
      'dropping "a_east" is refused by z_west(eastId) -> a_east ON DELETE RESTRICT; dropping "z_west" is refused by z_west(eastId) -> a_east ON DELETE RESTRICT.',
    ],
  ] as const) {
    test(`z_west -> a_east ${pick}, a_east -> z_west ${back} is refused before any statement runs`, async () => {
      const driver = await seededCycle(pick, back);
      await expect(
        migrationsFor(driver, {}).push({ dryRun: true, resolve: proceed })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        meta: { type: "cyclic-table-drop" },
        message: expect.stringContaining(
          `Tables "a_east", "z_west" cannot be dropped in an order that satisfies their foreign keys: ${refusals}`
        ),
      });
      expect(await tables(driver)).toEqual(["a_east", "z_west"]);
      expect(await count(driver, "z_west")).toBe(3);
      expect(await count(driver, "a_east")).toBe(2);
      await driver.disconnect();
    });
  }

  function tree(onDelete: "setNull" | "restrict") {
    const node = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .name("tree")
        .fields("parentId")
        .references("id")
        .onDelete(onDelete),
      children: s.toMany(() => node).name("tree"),
    });
    return { node };
  }

  async function seededTree(onDelete: "setNull" | "restrict") {
    const driver = createInMemorySQLite3Driver();
    await migrationsFor(driver, tree(onDelete)).push();
    await driver._executeRaw(
      `INSERT INTO "node" ("id", "parentId") VALUES ('root', NULL), ('kid', 'root')`
    );
    return driver;
  }

  test("a populated self-reference whose delete action accepts it is dropped", async () => {
    const driver = await seededTree("setNull");
    const { applied } = await pushDestructive(driver, {});
    expect(applied.outcome).toBe("applied");
    expect(await tables(driver)).toEqual([]);
    await driver.disconnect();
  });

  test("a populated RESTRICT self-reference is refused before any statement runs", async () => {
    const driver = await seededTree("restrict");
    await expect(
      migrationsFor(driver, {}).push({ dryRun: true, resolve: proceed })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "cyclic-table-drop" },
      message: expect.stringContaining(
        'Tables "node" cannot be dropped in an order that satisfies their foreign keys: dropping "node" is refused by node(parentId) -> node ON DELETE RESTRICT.'
      ),
    });
    expect(await count(driver, "node")).toBe(2);
    await driver.disconnect();
  });
});

test("a generated migration applies child-first and its rollback recreates parent-first", async () => {
  const driver = createInMemorySQLite3Driver();
  const storage = new MemoryEstateStorage();
  const pair = parentAndChild("aaa_parent", "zzz_child");
  const full = createMigrationClient(createClient({ schema: pair, driver }), {
    storage,
  });
  await full.generate({ name: "init" });
  await full.apply();
  await seedPair(driver, "aaa_parent", "zzz_child");

  const empty = createMigrationClient(createClient({ schema: {}, driver }), {
    storage,
  });
  const generated = await empty.generate({ name: "drop", resolve: proceed });
  expect(
    generated.operations.flatMap((operation) =>
      operation.type === "dropTable" ? [operation.tableName] : []
    )
  ).toEqual(["zzz_child", "aaa_parent"]);
  expect((await empty.apply()).outcome).toBe("applied");
  expect(
    (await tables(driver)).filter((name) => !name.startsWith("_viborm"))
  ).toEqual([]);

  // The inverse program recreates the parent before the child that references
  // it; the rows are gone, as the rollback warning says.
  await empty.down();
  expect(
    (await tables(driver)).filter((name) => !name.startsWith("_viborm"))
  ).toEqual(["aaa_parent", "zzz_child"]);
  expect(await count(driver, "zzz_child")).toBe(0);
  const childDefinition = await rows(
    driver,
    `SELECT sql FROM sqlite_master WHERE name = 'zzz_child'`
  );
  expect(String(childDefinition[0]?.sql)).toContain('REFERENCES "aaa_parent"');
  await driver.disconnect();
});
