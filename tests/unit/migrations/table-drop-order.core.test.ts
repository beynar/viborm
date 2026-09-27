/**
 * Issue #42: table removal follows the foreign keys that exist, not the names.
 *
 * `prepareSchemaProgram` orders every generated program's `dropTable`
 * operations child-first from the CURRENT snapshot (`orderTableDrops`,
 * `src/migrations/drop-order.ts`). These contracts enter through the public
 * generate path on planning drivers, so they read the program and SQL that
 * would be published, and open no database. Live SQLite3 application is in
 * `table-drop-order.test.ts`; PostgreSQL in `table-drop-order-pglite.test.ts`.
 *
 * Before the fix a SQLite program dropped in catalog order: `aaa_parent`
 * before `zzz_child`, which SQLite refuses when the child is populated.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { childrenBeforeParents } from "@src/migrations/drop-order";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { DiffOperation, ResolveCallback } from "@src/migrations/types";
import type { AnyModel } from "@src/schema/model";
import {
  type PlanningDialect,
  PlanningDriver,
} from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

const DROP_TABLE = /^DROP TABLE (?:IF EXISTS )?(\S+)$/gm;
const CREATE_TABLE = /^CREATE TABLE (\S+) \(/gm;
const DROP_FOREIGN_KEY = /DROP (?:CONSTRAINT|FOREIGN KEY)/;
const ADD_FOREIGN_KEY = /^ALTER TABLE \S+ ADD CONSTRAINT \S+ FOREIGN KEY/;

type Schema = Record<string, AnyModel>;

const proceed: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : change.reject();

function clientFor(dialect: PlanningDialect, schema: Schema) {
  return createClient({ schema, driver: new PlanningDriver(dialect) });
}

/** Generates `before`, then the transition to `after`, through the public client. */
async function transition(
  dialect: PlanningDialect,
  before: Schema,
  after: Schema,
  resolve: ResolveCallback = proceed
) {
  const storage = new MemoryEstateStorage();
  await createMigrationClient(clientFor(dialect, before), {
    storage,
  }).generate({ name: "before" });
  const migrations = createMigrationClient(clientFor(dialect, after), {
    storage,
  });
  return { storage, generate: () => migrations.generate({ resolve }) };
}

const unquote = (name: string) => name.replaceAll(/["`]/g, "").split(".").pop();
const matches = (sql: string, pattern: RegExp) =>
  [...sql.matchAll(pattern)].map((match) => unquote(match[1] ?? ""));
const droppedTables = (operations: readonly DiffOperation[]) =>
  operations.flatMap((operation) =>
    operation.type === "dropTable" ? [operation.tableName] : []
  );

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

describe("SQLite drops children before parents, whatever their names", () => {
  for (const [parentName, childName] of [
    ["aaa_parent", "zzz_child"],
    ["zzz_parent", "aaa_child"],
  ] as const) {
    test(`${parentName} / ${childName}`, async () => {
      const { generate } = await transition(
        "sqlite",
        parentAndChild(parentName, childName),
        {}
      );
      const generated = await generate();
      expect(droppedTables(generated.operations)).toEqual([
        childName,
        parentName,
      ]);
      expect(matches(generated.sql, DROP_TABLE)).toEqual([
        childName,
        parentName,
      ]);
      // The rollback is the inverse program: it recreates the parent first.
      expect(matches(generated.sql, CREATE_TABLE)).toEqual([
        parentName,
        childName,
      ]);
    });
  }
});

describe("PostgreSQL and MySQL roll a parent and child drop back tables first", () => {
  // The up program drops the key before either table; its inverse must
  // recreate both tables before it restores that key, and restore it once.
  for (const dialect of ["postgresql", "mysql"] as const) {
    for (const [parentName, childName] of [
      ["aaa_parent", "zzz_child"],
      ["zzz_parent", "aaa_child"],
    ] as const) {
      test(`${dialect}: ${parentName} / ${childName}`, async () => {
        const { generate } = await transition(
          dialect,
          parentAndChild(parentName, childName),
          {}
        );
        const { sql } = await generate();
        const rollback = sql.slice(sql.search(CREATE_TABLE)).split("\n\n");
        expect(matches(rollback.join("\n\n"), CREATE_TABLE).sort()).toEqual(
          [childName, parentName].sort()
        );
        const referencing = rollback.flatMap((statement, index) =>
          statement.includes("REFERENCES") ? [index] : []
        );
        expect(referencing).toHaveLength(1);
        const [keyRestore = -1] = referencing;
        expect(rollback[keyRestore]).toMatch(ADD_FOREIGN_KEY);
        const lastTableCreate = rollback
          .map((statement) => statement.startsWith("CREATE TABLE"))
          .lastIndexOf(true);
        expect(keyRestore).toBeGreaterThan(lastTableCreate);
      });
    }
  }
});

describe("dependency shapes", () => {
  test("a three-level chain drops leaf, middle, root", async () => {
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
          .references("id"),
        leaves: s.toMany(() => leaf),
      })
      .map("b_mid");
    const leaf = s
      .model({
        id: s.string().id(),
        midId: s.string(),
        mid: s
          .toOne(() => mid)
          .fields("midId")
          .references("id"),
      })
      .map("c_leaf");
    const { generate } = await transition("sqlite", { root, mid, leaf }, {});
    expect(droppedTables((await generate()).operations)).toEqual([
      "c_leaf",
      "b_mid",
      "a_root",
    ]);
  });

  test("a diamond drops its bottom first and its top last", async () => {
    const top = s
      .model({
        id: s.string().id(),
        wests: s.toMany(() => west),
        easts: s.toMany(() => east),
      })
      .map("a_top");
    const west = s
      .model({
        id: s.string().id(),
        topId: s.string(),
        top: s
          .toOne(() => top)
          .fields("topId")
          .references("id"),
        bottoms: s.toMany(() => bottom),
      })
      .map("b_west");
    const east = s
      .model({
        id: s.string().id(),
        topId: s.string(),
        top: s
          .toOne(() => top)
          .fields("topId")
          .references("id"),
        bottoms: s.toMany(() => bottom),
      })
      .map("c_east");
    const bottom = s
      .model({
        id: s.string().id(),
        westId: s.string(),
        eastId: s.string(),
        west: s
          .toOne(() => west)
          .fields("westId")
          .references("id"),
        east: s
          .toOne(() => east)
          .fields("eastId")
          .references("id"),
      })
      .map("d_bottom");
    const { generate } = await transition(
      "sqlite",
      { top, west, east, bottom },
      {}
    );
    // Independent middles keep the order they were given.
    expect(droppedTables((await generate()).operations)).toEqual([
      "d_bottom",
      "b_west",
      "c_east",
      "a_top",
    ]);
  });

  test("two foreign keys between the same tables are one dependency", async () => {
    const account = s
      .model({
        id: s.string().id(),
        owned: s.toMany(() => doc).name("owner"),
        edited: s.toMany(() => doc).name("editor"),
      })
      .map("a_account");
    const doc = s
      .model({
        id: s.string().id(),
        ownerId: s.string(),
        editorId: s.string(),
        owner: s
          .toOne(() => account)
          .name("owner")
          .fields("ownerId")
          .references("id"),
        editor: s
          .toOne(() => account)
          .name("editor")
          .fields("editorId")
          .references("id"),
      })
      .map("b_doc");
    const { generate } = await transition("sqlite", { account, doc }, {});
    expect(droppedTables((await generate()).operations)).toEqual([
      "b_doc",
      "a_account",
    ]);
  });

  test("an implicit junction drops before both of its endpoints", async () => {
    const post = s.model({
      id: s.string().id(),
      tags: s.toMany(() => tag),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const { generate } = await transition("sqlite", { post, tag }, {});
    const dropped = droppedTables((await generate()).operations);
    expect(dropped).toHaveLength(3);
    const junction = dropped[0] ?? "";
    expect(["post", "tag"]).not.toContain(junction);
    expect(dropped.slice(1).sort()).toEqual(["post", "tag"]);
  });

  test("unrelated drops keep their given order", async () => {
    const one = s.model({ id: s.string().id() }).map("m_one");
    const two = s.model({ id: s.string().id() }).map("b_two");
    const three = s.model({ id: s.string().id() }).map("x_three");
    const baseline = await transition("sqlite", { one, two, three }, {});
    const given = droppedTables((await baseline.generate()).operations);
    expect([...given].sort()).toEqual(["b_two", "m_one", "x_three"]);
    const again = await transition("sqlite", { one, two, three }, {});
    expect(droppedTables((await again.generate()).operations)).toEqual(given);
    expect(childrenBeforeParents(given, (name) => name, []).ordered).toEqual(
      given
    );
  });
});

describe("programs that do more than drop", () => {
  test("creates, drops and a rebuild keep their places around the ordered drops", async () => {
    const pair = parentAndChild("aaa_parent", "zzz_child");
    const keeper = s.model({ id: s.string().id(), size: s.string() });
    const widened = s.model({ id: s.string().id(), size: s.int() });
    const fresh = s.model({ id: s.string().id() });
    const { generate } = await transition(
      "sqlite",
      { ...pair, keeper },
      { keeper: widened, fresh },
      (change) => {
        if (change.type === "ambiguous") return change.addAndDrop();
        return change.type === "destructive"
          ? change.proceed()
          : change.reject();
      }
    );
    const operations = (await generate()).operations.map((operation) =>
      operation.type === "dropTable"
        ? `drop ${operation.tableName}`
        : operation.type === "createTable"
          ? `create ${operation.table.name}`
          : operation.type
    );
    expect(operations).toEqual([
      "drop zzz_child",
      "drop aaa_parent",
      "create fresh",
      "alterColumn",
    ]);
  });

  test("a table renamed in the same program does not disturb the drop order", async () => {
    const pair = parentAndChild("aaa_parent", "zzz_child");
    const kept = s.model({ id: s.string().id(), label: s.string() });
    const { generate } = await transition(
      "sqlite",
      { ...pair, kept: kept.map("old_kept") },
      { kept: kept.map("new_kept") },
      (change) => {
        if (change.type === "ambiguous") return change.rename();
        return change.type === "destructive"
          ? change.proceed()
          : change.reject();
      }
    );
    const operations = (await generate()).operations.map((operation) =>
      operation.type === "dropTable"
        ? `drop ${operation.tableName}`
        : operation.type === "renameTable"
          ? `rename ${operation.from} ${operation.to}`
          : operation.type
    );
    expect(operations).toEqual([
      "drop zzz_child",
      "drop aaa_parent",
      "rename old_kept new_kept",
    ]);
  });

  test("a retained child's planned key removal precedes its parent's drop", async () => {
    const pair = parentAndChild("aaa_parent", "zzz_child");
    const orphan = s
      .model({ id: s.string().id(), parentId: s.string() })
      .map("zzz_child");
    const { generate } = await transition("sqlite", pair, { child: orphan });
    const types = (await generate()).operations.map((operation) =>
      operation.type === "dropTable"
        ? `drop ${operation.tableName}`
        : operation.type
    );
    expect(types.indexOf("dropForeignKey")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("dropForeignKey")).toBeLessThan(
      types.indexOf("drop aaa_parent")
    );
    expect(types).not.toContain("drop zzz_child");
  });
});

describe("cycles", () => {
  type DeleteAction = "cascade" | "setNull" | "restrict" | "noAction";

  /**
   * `a_west` and `b_east` reference each other; each key's delete action is
   * given (a nullable relation defaults to SET NULL). `z_spoke` references the
   * cycle and `c_root` is referenced by it, both under RESTRICT: both are
   * dropped with it, neither is on it.
   */
  function cycle(pick: DeleteAction = "setNull", back: DeleteAction = pick) {
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
        spokes: s.toMany(() => spoke),
      })
      .map("a_west");
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
        rootId: s.string(),
        root: s
          .toOne(() => root)
          .fields("rootId")
          .references("id"),
      })
      .map("b_east");
    const root = s
      .model({ id: s.string().id(), easts: s.toMany(() => east) })
      .map("c_root");
    const spoke = s
      .model({
        id: s.string().id(),
        westId: s.string(),
        west: s
          .toOne(() => west)
          .fields("westId")
          .references("id"),
      })
      .map("z_spoke");
    return { west, east, root, spoke };
  }

  test("SQLite breaks a cycle at a key whose delete action accepts it", async () => {
    // Dropping `a_west` sets `b_east.westId` to NULL and dropping `b_east`
    // sets `a_west.eastId` to NULL, so either may go first. The spoke still
    // goes before `a_west` and `b_east` before its root: RESTRICT keys.
    const { generate } = await transition("sqlite", cycle(), {});
    expect(droppedTables((await generate()).operations)).toEqual([
      "z_spoke",
      "a_west",
      "b_east",
      "c_root",
    ]);
  });

  test("SQLite breaks a cycle only where a cascade leaves nothing to refuse", async () => {
    // Dropping `a_west` cascades into `b_east`, whose rows `a_west` refers
    // to under NO ACTION: settled, since every `a_west` row is gone by the
    // end of that statement. Dropping `b_east` first would leave `a_west`
    // rows pointing at nothing.
    const west = await transition("sqlite", cycle("noAction", "cascade"), {});
    expect(droppedTables((await west.generate()).operations)).toEqual([
      "z_spoke",
      "a_west",
      "b_east",
      "c_root",
    ]);
    const east = await transition("sqlite", cycle("cascade", "noAction"), {});
    expect(droppedTables((await east.generate()).operations)).toEqual([
      "z_spoke",
      "b_east",
      "a_west",
      "c_root",
    ]);
  });

  test("SQLite refuses a cycle before anything is published, naming each blocked table and why", async () => {
    const { storage, generate } = await transition(
      "sqlite",
      cycle("restrict", "noAction"),
      {}
    );
    const states = await storage.listStates();
    const refusal = await generate().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(refusal).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "cyclic-table-drop" },
    });
    expect(refusal).toHaveProperty(
      "message",
      expect.stringContaining(
        'Tables "a_west", "b_east", "c_root" cannot be dropped in an order that satisfies their foreign keys: dropping "a_west" is refused by b_east(westId) -> a_west ON DELETE NO ACTION; dropping "b_east" is refused by a_west(eastId) -> b_east ON DELETE RESTRICT; dropping "c_root" is refused by b_east(rootId) -> c_root ON DELETE RESTRICT.'
      )
    );
    expect(await storage.listStates()).toEqual(states);
  });

  test("SQLite refuses a cascade into rows that RESTRICT still guards", async () => {
    // Dropping `a_west` cascades into `b_east`, and a remaining `a_west` row
    // may still point at a cascaded `b_east` row: RESTRICT checks it at once.
    // Dropping `b_east` first leaves `a_west` rows pointing at nothing.
    const { generate } = await transition(
      "sqlite",
      cycle("restrict", "cascade"),
      {}
    );
    await expect(generate()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "cyclic-table-drop" },
      message: expect.stringContaining(
        'dropping "a_west" is refused by a_west(eastId) -> b_east ON DELETE RESTRICT; dropping "b_east" is refused by a_west(eastId) -> b_east ON DELETE RESTRICT;'
      ),
    });
  });

  for (const dialect of ["postgresql", "mysql"] as const) {
    test(`${dialect} drops the cycle's keys first and keeps its table drops as given`, async () => {
      const { generate } = await transition(
        dialect,
        cycle("restrict", "noAction"),
        {}
      );
      const generated = await generate();
      const forward = generated.sql.slice(
        0,
        generated.sql.search(CREATE_TABLE)
      );
      const lastKeyDrop = forward
        .split("\n")
        .map((line) => DROP_FOREIGN_KEY.test(line))
        .lastIndexOf(true);
      const firstTableDrop = forward
        .split("\n")
        .findIndex((line) => line.startsWith("DROP TABLE"));
      expect(lastKeyDrop).toBeGreaterThanOrEqual(0);
      expect(lastKeyDrop).toBeLessThan(firstTableDrop);
      expect(
        generated.operations.flatMap((operation) =>
          operation.type === "dropForeignKey" ? [operation.fkName] : []
        )
      ).toEqual(
        expect.arrayContaining(["a_west_eastId_fkey", "b_east_westId_fkey"])
      );
      // Nothing is left active to order by: `z_spoke`, a child of `a_west`,
      // keeps its place after it instead of moving first.
      expect(droppedTables(generated.operations)).toEqual([
        "a_west",
        "b_east",
        "c_root",
        "z_spoke",
      ]);
    });
  }
});

describe("self-references", () => {
  function tree(onDelete?: "restrict") {
    const node = s
      .model({
        id: s.string().id(),
        parentId: s.string().nullable(),
        parent: onDelete
          ? s
              .toOne(() => node)
              .name("tree")
              .fields("parentId")
              .references("id")
              .onDelete(onDelete)
          : s
              .toOne(() => node)
              .name("tree")
              .fields("parentId")
              .references("id"),
        children: s.toMany(() => node).name("tree"),
        leaves: s.toMany(() => leaf),
      })
      .map("a_node");
    const leaf = s
      .model({
        id: s.string().id(),
        nodeId: s.string(),
        node: s
          .toOne(() => node)
          .fields("nodeId")
          .references("id"),
      })
      .map("b_leaf");
    return { node, leaf };
  }

  test("SQLite drops a self-reference whose delete action accepts it", async () => {
    const { generate } = await transition("sqlite", tree(), {});
    expect(droppedTables((await generate()).operations)).toEqual([
      "b_leaf",
      "a_node",
    ]);
  });

  test("SQLite refuses a RESTRICT self-reference and names only it", async () => {
    const { generate } = await transition("sqlite", tree("restrict"), {});
    await expect(generate()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "cyclic-table-drop" },
      message: expect.stringContaining(
        'Tables "a_node" cannot be dropped in an order that satisfies their foreign keys: dropping "a_node" is refused by a_node(parentId) -> a_node ON DELETE RESTRICT.'
      ),
    });
  });

  test("PostgreSQL drops a RESTRICT self-reference's key first", async () => {
    const { generate } = await transition("postgresql", tree("restrict"), {});
    const generated = await generate();
    expect(
      generated.operations.filter(
        (operation) =>
          operation.type === "dropForeignKey" &&
          operation.fkName === "a_node_parentId_fkey"
      )
    ).toHaveLength(1);
  });
});
