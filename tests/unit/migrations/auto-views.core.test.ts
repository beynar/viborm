/**
 * Views kept by triggers (`.materialized({ refresh: "auto" })`) in the
 * migration layer, without a database: what a view's query may hold (the
 * rules shared with SurrealDB, and the key its triggers need), MySQL's
 * cascades and their refusals, the snapshot (its table, its keepers, its
 * identity apart from the other kinds), a stored snapshot, the differ and
 * the program rule, the probes, the advice on an unindexed `by`, and the
 * names of the keepers.
 */

import { s } from "@schema";
import type { AnyModel, Model } from "@schema/model";
import { validateSchema } from "@schema/validation/validator";
import { autoViewObjectName } from "@schema/view/auto-names";
import { probeForGeneratedStatement } from "@src/migrations/catalog-probes";
import { diff } from "@src/migrations/differ";
import type { MigrationDriver } from "@src/migrations/drivers/base";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import type { DiffOperation, SchemaSnapshot } from "@src/migrations/types";
import {
  encodeSnapshot,
  parseSnapshotDocument,
} from "@src/migrations/v1-parse-snapshot";
import {
  readAutoViews,
  refuseRelationCollision,
  withViewReplacements,
} from "@src/migrations/view";
import { describe, expect, it } from "vitest";
import { ddlContext } from "./_estate";

const LONG_NAME =
  /that is named 'b{52}', longer than 51 characters: the view that holds its body takes its name and '_viborm_body'/;
const STALE_DOCUMENT =
  /View 'byShop' cannot be created from a query that selects 'shop' through a relation: its triggers keep it current for the writes to its source table only/;
const RELATION_FILTER = /that filters through a relation/;
const WINDOW = /that takes a window/;
const DISTINCT = /that keeps one row per distinct value/;
const HAVING = /that keeps the groups a having holds/;
const NO_KEY =
  /View 'byShop' cannot be created from a query that does not select the key of 'sale': its triggers find the row a write touched by that key/;
const NULLABLE_BY =
  /that groups by the nullable 'region': a group of NULL has no key its triggers can find it by/;
const OVER_A_VIEW = /that reads the view 'paid'/;
const SELF_CASCADE =
  /View 'by_shop' cannot be kept current by triggers on MySQL: deleting a row of 'sales' cascades to 'sales', which the same delete reaches first, and MySQL refuses a trigger that changes a table its statement changes \(error 1442\)/;
const READ_ON_UPDATE =
  /changes its column 'shopId', which the view reads, on an update of 'shops' \(onUpdate "cascade"\)/;
const BOTH_KINDS = /materialized or kept by triggers, not both/;
const UNSORTED_OBJECTS = /objects must be sorted by kind, then name/;
const H = "a".repeat(40);
const NARROWED_KEY =
  /View 'by_url' cannot be kept current by triggers: its key 'url' would be stored as VARCHAR\(191\), narrower than its source's TEXT/;
const LOCKED_FILL =
  /^INSERT INTO `by_shop` \(`shopId`, `count`, `sumAmount`\) SELECT `shopId`, `count`, `sumAmount` FROM \(SELECT .* FOR SHARE\) AS `b` ON DUPLICATE KEY UPDATE/;
const FOREIGN_BODY =
  /relation "by_shop_viborm_body" is a view VibORM did not create, but this schema declares a view of that name/;
const CUT_NAME = /^by_shop_viborm_on_p+_[0-9a-f]{8}$/;

type Fields = Record<string, unknown>;
const model = s.model as unknown as (shape: Fields) => Model<any>;
const view = s.view as unknown as (
  source: () => AnyModel,
  query: object
) => Model<any>;

interface Options {
  /** The sale's foreign key to its shop: its actions, its nullability. */
  readonly onDelete?: string;
  readonly onUpdate?: string;
  /** A sale that answers a sale (a self-reference, cascaded). */
  readonly replies?: boolean;
}

/** A shop and its sales, made anew (a model binds one schema for good). */
function shopSchema(options: Options = {}) {
  const shop: Model<any> = model({
    id: s.string().id(),
    sales: s.toMany(() => sale),
  }).map("shops");
  let relation = s
    .toOne(() => shop)
    .fields("shopId")
    .references("id") as any;
  if (options.onDelete) relation = relation.onDelete(options.onDelete);
  if (options.onUpdate) relation = relation.onUpdate(options.onUpdate);
  const sale: Model<any> = model({
    id: s.string().id(),
    shopId: s.string(),
    status: s.string(),
    region: s.string().nullable(),
    amount: s.int().nullable(),
    shop: relation,
    ...(options.replies
      ? {
          parentId: s.string().nullable(),
          parent: s
            .toOne(() => sale)
            .name("thread")
            .fields("parentId")
            .references("id")
            .onDelete("cascade"),
          replies: s.toMany(() => sale).name("thread"),
        }
      : {}),
  }).map("sales");
  return { shop, sale };
}

const BY_SHOP = {
  where: { status: "paid" },
  by: ["shopId"],
  _count: true,
  _sum: { amount: true },
};

function snapshotOf(
  query: object,
  migrationDriver: MigrationDriver,
  options: Options & { readonly kind?: "auto" | "materialized" | "plain" } = {}
): SchemaSnapshot {
  const { shop, sale } = shopSchema(options);
  let declared = view(() => sale, query);
  if (options.kind !== "plain")
    declared =
      options.kind === "materialized"
        ? declared.materialized()
        : declared.materialized({ refresh: "auto" });
  return serializeModels(
    { shop, sale, byShop: declared.map("by_shop") },
    { migrationDriver }
  );
}

const refusal =
  (query: object, migrationDriver: MigrationDriver = sqlite3MigrationDriver) =>
  () =>
    snapshotOf(query, migrationDriver);

describe("what a view kept by triggers may hold", () => {
  it("refuses, with the view named, what its triggers cannot keep: the rules shared with SurrealDB", () => {
    const cases: [object, RegExp][] = [
      [{ select: { id: true, shop: true } }, STALE_DOCUMENT],
      [{ where: { shop: { id: "a" } }, select: { id: true } }, RELATION_FILTER],
      [{ select: { id: true }, orderBy: { id: "asc" }, take: 2 }, WINDOW],
      [{ select: { id: true, status: true }, distinct: ["status"] }, DISTINCT],
      [{ by: ["shopId"], _count: true, having: { shopId: "a" } }, HAVING],
    ];
    for (const [query, message] of cases)
      expect(refusal(query)).toThrow(message);
  });

  it("refuses a view of rows without its source's key, and a group by a nullable field", () => {
    expect(refusal({ select: { shopId: true, amount: true } })).toThrow(NO_KEY);
    expect(refusal({ by: ["region"], _count: true })).toThrow(NULLABLE_BY);
  });

  it("refuses a name its body's view cannot take whole: the client names that view without a hash", () => {
    const { shop, sale } = shopSchema();
    const named = (name: string) => () =>
      serializeModels(
        {
          shop,
          sale,
          byShop: view(() => sale, BY_SHOP)
            .materialized({ refresh: "auto" })
            .map(name),
        },
        { migrationDriver: sqlite3MigrationDriver }
      );
    expect(named("b".repeat(51))).not.toThrow();
    expect(named("b".repeat(52))).toThrow(LONG_NAME);
  });

  it("refuses a view over a view, which takes no write", () => {
    const { shop, sale } = shopSchema();
    const paid = view(() => sale, {
      where: { status: "paid" },
      select: { id: true, amount: true },
    }).map("paid");
    const over = view(() => paid, { select: { id: true } })
      .materialized({ refresh: "auto" })
      .map("over");
    expect(() =>
      serializeModels(
        { shop, sale, paid, over },
        { migrationDriver: sqlite3MigrationDriver }
      )
    ).toThrow(OVER_A_VIEW);
  });

  it("keeps a sum of doubles and a least text, which SurrealDB refuses: a group is computed again whole", () => {
    expect(() =>
      snapshotOf(
        { by: ["shopId"], _min: { status: true } },
        postgresMigrationDriver
      )
    ).not.toThrow();
  });
});

describe("review of the first round (Devin, 2026-11-25)", () => {
  it("reads a mapped grouped field by its source's column in the triggers", () => {
    const sale = model({
      id: s.string().id(),
      shopId: s.string().map("shop_id"),
    }).map("sales");
    const byShop = view(() => sale, { by: ["shopId"], _count: true })
      .materialized({ refresh: "auto" })
      .map("by_shop");
    const [def] = serializeModels(
      { sale, byShop },
      { migrationDriver: sqlite3MigrationDriver }
    ).views!;
    expect(def!.auto!.storage).toMatchObject({
      key: ["shopId"],
      sourceKey: ["shop_id"],
    });
    const statements = sqlite3MigrationDriver
      .compileStatements({ type: "createView", view: def! }, ddlContext("live"))
      .join("\n");
    expect(statements).toContain('WHERE "shopId" = NEW."shop_id"');
    expect(statements).not.toContain('NEW."shopId"');
  });

  it("refuses on MySQL a key stored narrower than its source stores it, and takes one its source indexes", () => {
    const narrowed = (indexed: boolean) => () => {
      let doc: Model<any> = model({
        id: s.string().id(),
        url: s.string(),
      });
      if (indexed) doc = doc.index(["url"]);
      doc = doc.map("docs");
      return serializeModels(
        {
          doc,
          byUrl: view(() => doc, { by: ["url"], _count: true })
            .materialized({ refresh: "auto" })
            .map("by_url"),
        },
        { migrationDriver: mysqlMigrationDriver }
      );
    };
    expect(narrowed(false)).toThrow(NARROWED_KEY);
    expect(narrowed(true)).not.toThrow();
  });

  it("fills on MySQL with a locking read of the source, past which a write still open is read as it commits", () => {
    const [def] = snapshotOf(BY_SHOP, mysqlMigrationDriver).views!;
    const fill = mysqlMigrationDriver
      .compileStatements({ type: "createView", view: def! }, ddlContext("live"))
      .at(-1)!;
    expect(fill).toMatch(LOCKED_FILL);
  });

  it("computes a PostgreSQL group in a function parsed at its creation, run as its owner, and compares no value on update", () => {
    const [def] = snapshotOf(BY_SHOP, postgresMigrationDriver).views!;
    const ddl = postgresMigrationDriver
      .compileStatements({ type: "createView", view: def! }, ddlContext("live"))
      .join("\n");
    // Its operators resolved as the migration's search path resolves them
    // (an extension's `citext` included), none at a caller's.
    expect(ddl).toContain(
      'CREATE FUNCTION "by_shop_viborm_k"(k0 text) RETURNS void LANGUAGE sql SECURITY DEFINER\nBEGIN ATOMIC'
    );
    expect(ddl).toContain('  DELETE FROM "by_shop" WHERE "shopId" = k0;');
    expect(ddl).toContain('PERFORM "by_shop_viborm_k"(OLD."shopId");');
    // No guard of the values: `json` has no equality, and a text rounds.
    expect(ddl).toContain(
      'AFTER UPDATE OF "amount", "shopId", "status" ON "sales" FOR EACH ROW EXECUTE'
    );
    expect(ddl).not.toContain("SECURITY DEFINER AS $viborm$");
  });

  it("creates nothing over a helper's name it did not mark: the body's view is a declared relation", () => {
    const desired = snapshotOf(BY_SHOP, postgresMigrationDriver);
    expect(() =>
      refuseRelationCollision(
        "PostgreSQL",
        [desired],
        [{ name: "by_shop_viborm_body", kind: "view", definition: "SELECT 1" }]
      )
    ).toThrow(FOREIGN_BODY);
    const statements = postgresMigrationDriver.compileStatements(
      { type: "createView", view: desired.views![0]! },
      ddlContext("live")
    );
    expect(statements.filter((sql) => sql.startsWith("DROP "))).toEqual([]);
  });

  it("reads an ordinary view whose name ends as a body's as the view it is, without a trigger of its marker", () => {
    const views = [
      { name: "sales_viborm_body", hash: H, dependsOn: ["sales"] },
    ];
    expect(readAutoViews([], [], views)).toEqual([]);
    expect(views.map(({ name }) => name)).toEqual(["sales_viborm_body"]);
  });

  it("refuses no SQLite key of a mapped enum, whose CHECK names its own column", () => {
    const sale = model({
      id: s.string().id(),
      state: s.enum(["open", "paid"]).map("sale_state"),
    }).map("sales");
    expect(() =>
      serializeModels(
        {
          sale,
          byState: view(() => sale, { by: ["state"], _count: true })
            .materialized({ refresh: "auto" })
            .map("by_state"),
        },
        { migrationDriver: sqlite3MigrationDriver }
      )
    ).not.toThrow();
  });

  it("reads what a hand left of one (its body's view and triggers, no table) as a view to drop, never its name's table", () => {
    const views = [
      { name: "by_shop_viborm_body", hash: H, dependsOn: ["sales"] },
    ];
    const [left] = readAutoViews(
      [],
      [{ kind: "trigger", name: "by_shop_viborm_i", table: "sales", hash: H }],
      views
    );
    expect(views).toEqual([]);
    expect(left).toMatchObject({
      name: "by_shop",
      hash: "0".repeat(40),
      auto: {
        tableless: true,
        objects: [
          { kind: "trigger", name: "by_shop_viborm_i", table: "sales" },
          { kind: "view", name: "by_shop_viborm_body" },
        ],
      },
    });
    expect(
      sqlite3MigrationDriver.compileStatements(
        { type: "dropView", viewName: "by_shop", auto: left!.auto },
        ddlContext("live")
      )
    ).toEqual([
      'DROP TRIGGER IF EXISTS "by_shop_viborm_i"',
      'DROP VIEW IF EXISTS "by_shop_viborm_body"',
    ]);
  });
});

describe("MySQL's cascades", () => {
  it("records a trigger on each parent whose cascade reaches the source", () => {
    const auto = snapshotOf(BY_SHOP, mysqlMigrationDriver, {
      onDelete: "cascade",
    }).views![0]!.auto!;
    expect(auto.storage?.cascades).toEqual([
      {
        table: "shops",
        trigger: "by_shop_viborm_on_shops",
        children: [
          {
            table: "sales",
            columns: ["shopId"],
            referencedColumns: ["id"],
            action: "cascade",
          },
        ],
      },
    ]);
    expect(auto.objects).toContainEqual({
      kind: "trigger",
      name: "by_shop_viborm_on_shops",
      table: "shops",
    });
    // A cascade fires the triggers of the rows it deletes elsewhere.
    expect(
      snapshotOf(BY_SHOP, postgresMigrationDriver, { onDelete: "cascade" })
        .views![0]!.auto!.storage?.cascades
    ).toBeUndefined();
  });

  it("refuses a self-reference that cascades, and an onUpdate that changes a column the view reads", () => {
    expect(() =>
      snapshotOf(BY_SHOP, mysqlMigrationDriver, { replies: true })
    ).toThrow(SELF_CASCADE);
    expect(() =>
      snapshotOf(BY_SHOP, mysqlMigrationDriver, { onUpdate: "cascade" })
    ).toThrow(READ_ON_UPDATE);
    // The column read nowhere by the view: its update fires nothing it needs.
    expect(() =>
      snapshotOf(
        { where: { status: "paid" }, select: { id: true, status: true } },
        mysqlMigrationDriver,
        { onUpdate: "cascade" }
      )
    ).not.toThrow();
    // Elsewhere a cascade fires the triggers: nothing is refused.
    expect(() =>
      snapshotOf(BY_SHOP, sqlite3MigrationDriver, { replies: true })
    ).not.toThrow();
  });
});

describe("the snapshot", () => {
  it("holds the table, its key, what its triggers read, and every keeper, sorted", () => {
    const [byShop] = snapshotOf(BY_SHOP, postgresMigrationDriver).views!;
    expect(byShop).toMatchObject({
      name: "by_shop",
      dependsOn: ["sales"],
      auto: {
        objects: [
          { kind: "function", name: "by_shop_viborm" },
          { kind: "function", name: "by_shop_viborm_k" },
          { kind: "trigger", name: "by_shop_viborm_d", table: "sales" },
          { kind: "trigger", name: "by_shop_viborm_i", table: "sales" },
          { kind: "trigger", name: "by_shop_viborm_u", table: "sales" },
          { kind: "view", name: "by_shop_viborm_body" },
        ],
        storage: {
          source: "sales",
          key: ["shopId"],
          grouped: true,
          reads: ["amount", "shopId", "status"],
        },
      },
    });
    expect(byShop!.materialized).toBeUndefined();
    expect(byShop!.auto!.storage!.columns.map(({ name }) => name)).toEqual([
      "shopId",
      "count",
      "sumAmount",
    ]);
    // MySQL's triggers read each key's rows themselves.
    expect(
      snapshotOf(BY_SHOP, mysqlMigrationDriver).views![0]!.auto!.storage!.keyed
        ?.NEW
    ).toContain("NEW.`shopId`");
  });

  it("has an identity apart from the ordinary and the materialized view's", () => {
    const hash = (kind: "auto" | "materialized" | "plain") =>
      snapshotOf(BY_SHOP, sqlite3MigrationDriver, { kind }).views![0]!.hash;
    expect(hash("auto")).not.toBe(hash("plain"));
    // A materialized view is an ordinary one on SQLite: kept by triggers it is not.
    expect(hash("materialized")).toBe(hash("plain"));
  });

  it("round-trips through a stored snapshot, which admits it only whole", () => {
    const snapshot = snapshotOf(BY_SHOP, mysqlMigrationDriver, {
      onDelete: "cascade",
    });
    const parse = (value: SchemaSnapshot) => {
      const { bytes, snapshotHash } = encodeSnapshot(value);
      return parseSnapshotDocument(bytes, snapshotHash);
    };
    expect(parse(snapshot)).toEqual(snapshot);
    const [byShop] = snapshot.views!;
    const broken = (patch: object) => ({
      ...snapshot,
      views: [{ ...byShop, ...patch }],
    });
    expect(() => parse(broken({ materialized: true }) as never)).toThrow(
      BOTH_KINDS
    );
    expect(() =>
      parse(
        broken({
          auto: {
            ...byShop!.auto,
            objects: [...byShop!.auto!.objects].reverse(),
          },
        }) as never
      )
    ).toThrow(UNSORTED_OBJECTS);
  });
});

describe("the differ and the program rule", () => {
  const declared = () => snapshotOf(BY_SHOP, postgresMigrationDriver);
  const ops = (operations: readonly DiffOperation[]) =>
    operations.map((operation) =>
      operation.type === "createView"
        ? `createView ${operation.view.name}`
        : operation.type === "dropView"
          ? `dropView ${operation.viewName}${operation.auto ? " auto" : ""}`
          : `${operation.type} ${"tableName" in operation ? operation.tableName : ""}`
    );

  it("replaces a view one of whose keepers is gone, and keeps one whose keepers are all there", async () => {
    const desired = declared();
    const [byShop] = desired.views!;
    const live: SchemaSnapshot = {
      ...desired,
      views: [
        {
          ...byShop!,
          auto: {
            objects: byShop!.auto!.objects.filter(
              ({ name }) => name !== "by_shop_viborm_i"
            ),
          },
        },
      ],
    };
    expect(ops((await diff(live, desired)).operations)).toEqual([
      "dropView by_shop auto",
      "createView by_shop",
    ]);
    const whole: SchemaSnapshot = {
      ...desired,
      views: [{ ...byShop!, auto: { objects: byShop!.auto!.objects } }],
    };
    expect((await diff(whole, desired)).operations).toEqual([]);
  });

  it("replaces it around any change to its source but an index's, where an ordinary view survives the same", () => {
    const current = declared();
    const added: DiffOperation = {
      type: "addColumn",
      tableName: "sales",
      column: { name: "note", type: "text", nullable: true },
    };
    expect(ops(withViewReplacements([added], current, current, false))).toEqual(
      ["dropView by_shop auto", "addColumn sales", "createView by_shop"]
    );
    const plain = snapshotOf(BY_SHOP, postgresMigrationDriver, {
      kind: "plain",
    });
    expect(ops(withViewReplacements([added], plain, plain, false))).toEqual([
      "addColumn sales",
    ]);
    const indexed: DiffOperation = {
      type: "createIndex",
      tableName: "sales",
      index: { name: "sales_status_idx", columns: ["status"], unique: false },
    };
    expect(
      ops(withViewReplacements([indexed], current, current, false))
    ).toEqual(["createIndex sales"]);
  });

  it("replaces it around a change to a parent its MySQL triggers fire on", () => {
    const current = snapshotOf(BY_SHOP, mysqlMigrationDriver, {
      onDelete: "cascade",
    });
    const renamed: DiffOperation = {
      type: "addColumn",
      tableName: "shops",
      column: { name: "label", type: "text", nullable: true },
    };
    expect(
      ops(withViewReplacements([renamed], current, current, false))
    ).toEqual([
      "dropView by_shop auto",
      "addColumn shops",
      "createView by_shop",
    ]);
  });
});

describe("DDL and probes", () => {
  it("creates the table, its marker, the body's view, the triggers and the rows, and proves each by its own probe", () => {
    const [byShop] = snapshotOf(BY_SHOP, sqlite3MigrationDriver).views!;
    const operation: DiffOperation = { type: "createView", view: byShop! };
    const statements = sqlite3MigrationDriver.compileStatements(
      operation,
      ddlContext("live")
    );
    expect(
      statements.map((statement) => statement.split(" (")[0]!.split("\n")[0])
    ).toEqual([
      'CREATE TABLE "by_shop"',
      'CREATE VIEW "by_shop_viborm_body" AS SELECT "shopId", "count", "sumAmount" FROM',
      'CREATE TRIGGER "by_shop_viborm_i" AFTER INSERT ON "sales" BEGIN',
      'CREATE TRIGGER "by_shop_viborm_u" AFTER UPDATE OF "amount", "shopId", "status" ON "sales" WHEN OLD."amount" IS NOT NEW."amount" OR OLD."shopId" IS NOT NEW."shopId" OR OLD."status" IS NOT NEW."status" BEGIN',
      'CREATE TRIGGER "by_shop_viborm_d" AFTER DELETE ON "sales" BEGIN',
      'INSERT INTO "by_shop"',
    ]);
    const probe = (statement: string) =>
      probeForGeneratedStatement(sqlite3MigrationDriver, operation, statement)
        ?.post.id;
    expect(statements.map(probe)).toEqual([
      "table:exists:by_shop",
      "view:exists:by_shop_viborm_body",
      "trigger:exists:sales.by_shop_viborm_i",
      "trigger:exists:sales.by_shop_viborm_u",
      "trigger:exists:sales.by_shop_viborm_d",
      undefined,
    ]);
  });

  it("drops what keeps it first, each skipped where a hand dropped it, then its table", () => {
    const [byShop] = snapshotOf(BY_SHOP, postgresMigrationDriver).views!;
    expect(
      postgresMigrationDriver.compileStatements(
        { type: "dropView", viewName: "by_shop", auto: byShop!.auto },
        ddlContext("live")
      )
    ).toEqual([
      'DROP TRIGGER IF EXISTS "by_shop_viborm_d" ON "sales"',
      'DROP TRIGGER IF EXISTS "by_shop_viborm_i" ON "sales"',
      'DROP TRIGGER IF EXISTS "by_shop_viborm_u" ON "sales"',
      'DROP FUNCTION IF EXISTS "by_shop_viborm"',
      'DROP FUNCTION IF EXISTS "by_shop_viborm_k"',
      'DROP VIEW IF EXISTS "by_shop_viborm_body"',
      'DROP TABLE "by_shop"',
    ]);
  });
});

describe("advice", () => {
  it("warns (W006) where no index of the source begins with the grouped fields", () => {
    const { shop, sale } = shopSchema();
    const warned = (by: string[]) =>
      validateSchema({
        shop,
        sale,
        byShop: view(() => sale, { by, _count: true })
          .materialized({ refresh: "auto" })
          .map("by_shop"),
      }).warnings.filter(({ code }) => code === "W006");
    // A foreign key's column is indexed by every migration.
    expect(warned(["shopId"])).toEqual([]);
    expect(warned(["status"])).toEqual([
      expect.objectContaining({
        model: "byShop",
        message: expect.stringContaining(
          "'status', which no index of its source begins with"
        ),
      }),
    ]);
  });
});

describe("names", () => {
  it("names each keeper after its view, cut and hashed past 63 characters, a cascade's parent of any length included", () => {
    expect(autoViewObjectName("by_shop", "_i")).toBe("by_shop_viborm_i");
    const parent = "p".repeat(63);
    const name = autoViewObjectName("by_shop", `_on_${parent}`);
    expect(name).toHaveLength(63);
    expect(name).toMatch(CUT_NAME);
    expect(autoViewObjectName("by_shop", `_on_${parent.slice(1)}q`)).not.toBe(
      name
    );
  });
});
