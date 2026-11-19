/**
 * Materialized views (`s.view(…).materialized()`) in the migration layer,
 * without a database: what the serializer records on PostgreSQL (the kind,
 * a unique index per derived key, each declared index) and on the dialects
 * that keep such a view ordinary (nothing at all), what a stored snapshot
 * admits, the identity and the fingerprint, the differ (an index change is an
 * index operation, a changed hash a replacement that brings the indexes, never
 * both), the program rule, the DDL, the probes, the inverse, Neki's commit
 * boundary, the collision refusal and the plan's words.
 */

import { s } from "@schema";
import type { AnyModel, Model } from "@schema/model";
import { probeForGeneratedStatement } from "@src/migrations/catalog-probes";
import { lowLockSteps } from "@src/migrations/compile";
import { diff } from "@src/migrations/differ";
import { getMigrationDriver } from "@src/migrations/drivers";
import type { MigrationDriver } from "@src/migrations/drivers/base";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { invertOperations } from "@src/migrations/invert";
import { formatOperation } from "@src/migrations/push/format";
import {
  fingerprintDeparsed,
  fingerprintSnapshot,
} from "@src/migrations/push-fingerprint";
import { serializeModels } from "@src/migrations/serializer";
import { catalogCommitBoundaries } from "@src/migrations/statement-safety";
import type {
  DiffOperation,
  IndexDef,
  SchemaSnapshot,
  TableDef,
  ViewDef,
} from "@src/migrations/types";
import { prepareSchemaProgram } from "@src/migrations/utils";
import {
  encodeSnapshot,
  parseSnapshotDocument,
} from "@src/migrations/v1-parse-snapshot";
import {
  refuseRelationCollision,
  withViewReplacements,
} from "@src/migrations/view";
import { describe, expect, it } from "vitest";
import { ddlContext, pgEstateDriver } from "./_estate";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

const NOT_TRUE = /materialized must be true when present/;
const ORDINARY_INDEXES = /indexes belong to a materialized view/;
const EMPTY_INDEXES = /indexes must be a non-empty array when present/;
const INDEX_UNIQUE = /unique must be boolean/;
const TABLE_OVER_MATERIALIZED =
  /relation "v" is a materialized view VibORM did not create, but this schema declares a table/;
const VIEW_OVER_MATERIALIZED =
  /relation "v" is a materialized view VibORM did not create, but this schema declares a view/;

// Schemas built with and without a member: the builders are taken untyped,
// a model's type is not what is tested.
type Fields = Record<string, unknown>;
const model = s.model as unknown as (shape: Fields) => Model<any>;
const view = s.view as unknown as (
  source: () => AnyModel,
  query: object
) => Model<any>;

/** A fresh schema each time: a model object binds one schema key for good. */
function posts() {
  return model({
    id: s.string().id(),
    slug: s.string().unique(),
    region: s.string(),
    code: s.string(),
    title: s.string().map("headline"),
    views: s.int(),
  })
    .unique(["region", "code"], { name: "regionCode" })
    .map("posts");
}

/** How the feed is declared: kind and indexes beside one query. */
interface Declared {
  readonly materialized?: boolean;
  readonly indexes?: readonly (readonly [string[], object?])[];
  readonly select?: object;
}

function feedSnapshot(
  declared: Declared,
  migrationDriver: MigrationDriver = postgresMigrationDriver
): SchemaSnapshot {
  const post = posts();
  let feed = view(() => post, {
    where: { views: { gt: 10 } },
    ...(declared.select ? { select: declared.select } : {}),
  });
  if (declared.materialized) feed = feed.materialized();
  for (const [fields, options] of declared.indexes ?? [])
    feed = feed.index(fields, options);
  return serializeModels({ post, feed: feed.map("feed") }, { migrationDriver });
}

const feedOf = (snapshot: SchemaSnapshot): ViewDef => snapshot.views![0]!;

const table = (name: string, columns = ["id", "title"]): TableDef => ({
  name,
  columns: columns.map((column) => ({
    name: column,
    type: "text",
    nullable: false,
  })),
  primaryKey: { columns: ["id"], name: `${name}_pkey` },
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
});

const KEY: IndexDef = { name: "feed_pkey", columns: ["id"], unique: true };
const BY_TITLE: IndexDef = {
  name: "feed_title_idx",
  columns: ["title"],
  unique: false,
};

const stored = (
  hash: string,
  indexes: IndexDef[] = [KEY],
  name = "feed"
): ViewDef => ({
  name,
  hash,
  sql: 'SELECT "id", "title" FROM "posts"',
  dependsOn: ["posts"],
  materialized: true,
  ...(indexes.length > 0 ? { indexes } : {}),
});

const ordinary = (hash: string, name = "feed"): ViewDef => ({
  name,
  hash,
  sql: 'SELECT "id", "title" FROM "posts"',
  dependsOn: ["posts"],
});

const snapshot = (views: ViewDef[], tables = [table("posts")]) => ({
  tables,
  views,
});

describe("the snapshot of a materialized view", () => {
  it("on PostgreSQL holds the kind, a unique index per derived key, then each declared index", () => {
    const feed = feedOf(
      feedSnapshot({
        materialized: true,
        indexes: [
          [["title"]],
          [["views"], { name: "by_views", type: "hash" }],
          [["region", "views"], { where: '"views" > 100' }],
        ],
      })
    );
    expect(feed.materialized).toBe(true);
    // The keys: what findUnique can name, named as a table's primary key and
    // uniques are; then the declared ones, named as a table's indexes are,
    // over the mapped column.
    expect(feed.indexes).toEqual([
      { name: "feed_pkey", columns: ["id"], unique: true },
      { name: "feed_slug_key", columns: ["slug"], unique: true },
      {
        name: "feed_regionCode_key",
        columns: ["region", "code"],
        unique: true,
      },
      {
        name: "feed_title_idx",
        columns: ["headline"],
        unique: false,
        type: undefined,
        where: undefined,
      },
      {
        name: "by_views",
        columns: ["views"],
        unique: false,
        type: "hash",
        where: undefined,
      },
      {
        name: "feed_region_views_idx",
        columns: ["region", "views"],
        unique: false,
        type: undefined,
        where: '"views" > 100',
      },
    ]);
  });

  it("keys only what the view projects, and a keyless view without a declared index has no index", () => {
    const projected = feedOf(
      feedSnapshot({
        materialized: true,
        select: { slug: true, region: true, views: true },
      })
    );
    expect(projected.indexes).toEqual([
      { name: "feed_slug_key", columns: ["slug"], unique: true },
    ]);
    const keyless = feedOf(
      feedSnapshot({ materialized: true, select: { title: true } })
    );
    expect(keyless.materialized).toBe(true);
    expect("indexes" in keyless).toBe(false);
  });

  it("names its indexes through the driver's pass over a table's, so a long one fits", () => {
    const post = posts();
    // 63 bytes at most, as every identifier; its derived names are longer.
    const long = `feed_${"x".repeat(55)}`;
    const feed = serializeModels(
      {
        post,
        feed: view(() => post, {})
          .materialized()
          .index(["title"])
          .map(long),
      },
      { migrationDriver: postgresMigrationDriver }
    ).views![0]!;
    expect(feed.indexes).toHaveLength(4);
    for (const index of feed.indexes ?? []) {
      expect(new TextEncoder().encode(index.name).length).toBeLessThan(64);
      expect(index.name).not.toBe(`${long}_pkey`);
    }
  });

  it("changes the hash on PostgreSQL, and its indexes never do", () => {
    const plain = feedOf(feedSnapshot({}));
    const materialized = feedOf(feedSnapshot({ materialized: true }));
    const indexed = feedOf(
      feedSnapshot({ materialized: true, indexes: [[["title"]]] })
    );
    expect(materialized.hash).not.toBe(plain.hash);
    expect(indexed.hash).toBe(materialized.hash);
    expect(materialized.sql).toBe(plain.sql);
    // An ordinary view's snapshot carries neither key.
    expect(Object.keys(plain).sort()).toEqual([
      "dependsOn",
      "hash",
      "name",
      "sql",
    ]);
  });

  it("on MySQL and SQLite is the ordinary view's: same definition, hash and bytes", () => {
    for (const driver of [mysqlMigrationDriver, sqlite3MigrationDriver]) {
      const plain = feedSnapshot({}, driver);
      const materialized = feedSnapshot(
        { materialized: true, indexes: [[["title"]], [["views"]]] },
        driver
      );
      expect(feedOf(materialized)).toEqual(feedOf(plain));
      expect(encodeSnapshot(materialized).snapshotHash).toBe(
        encodeSnapshot(plain).snapshotHash
      );
    }
  });
});

describe("a stored snapshot", () => {
  const document = (views: unknown[]) => {
    const value = { enums: [], tables: [], views } as unknown as SchemaSnapshot;
    const { bytes, snapshotHash } = encodeSnapshot(value);
    return () => parseSnapshotDocument(bytes, snapshotHash);
  };

  it("round-trips a materialized view with its indexes, and one without any", () => {
    const value = snapshot([stored(H1, [KEY, BY_TITLE]), stored(H2, [], "z")]);
    const { bytes, snapshotHash } = encodeSnapshot(value);
    expect(parseSnapshotDocument(bytes, snapshotHash)).toEqual(value);
  });

  it("admits the kind only as true, and indexes only on a materialized view, never empty", () => {
    expect(document([{ ...stored(H1), materialized: false }])).toThrow(
      NOT_TRUE
    );
    expect(document([{ ...ordinary(H1), indexes: [KEY] }])).toThrow(
      ORDINARY_INDEXES
    );
    expect(document([{ ...stored(H1), indexes: [] }])).toThrow(EMPTY_INDEXES);
    expect(
      document([{ ...stored(H1), indexes: [{ ...KEY, unique: "yes" }] }])
    ).toThrow(INDEX_UNIQUE);
  });
});

describe("identity and fingerprint", () => {
  it("a materialized view adds its kind and indexes; an ordinary one keeps its fingerprint", () => {
    const pg = postgresMigrationDriver;
    const base = snapshot([ordinary(H1)]);
    const asBefore = fingerprintSnapshot(
      { tables: [table("posts")], views: [ordinary(H1)] },
      pg
    );
    expect(fingerprintSnapshot(base, pg)).toBe(asBefore);
    const materialized = fingerprintSnapshot(snapshot([stored(H1)]), pg);
    expect(materialized).not.toBe(asBefore);
    expect(
      fingerprintSnapshot(snapshot([stored(H1, [KEY, BY_TITLE])]), pg)
    ).not.toBe(materialized);
    // Index order and an undeclared method or uniqueness read as the catalog's.
    expect(
      fingerprintSnapshot(
        snapshot([
          stored(H1, [
            { ...BY_TITLE, type: "btree" },
            { ...KEY, where: undefined },
          ]),
        ]),
        pg
      )
    ).toBe(fingerprintSnapshot(snapshot([stored(H1, [KEY, BY_TITLE])]), pg));
  });

  it("a partial index of a view takes the deparse recorded under the view's name", () => {
    const pg = postgresMigrationDriver;
    const partial = { ...BY_TITLE, where: "views > 1" };
    const declared = snapshot([stored(H1, [KEY, partial])]);
    const live = snapshot([
      stored(H1, [KEY, { ...partial, where: "(views > 1)" }]),
    ]);
    expect(
      fingerprintDeparsed(
        declared,
        [{ table: "feed", index: partial.name, deparsed: "(views > 1)" }],
        pg
      )
    ).toBe(fingerprintSnapshot(live, pg));
    expect(fingerprintDeparsed(declared, [], pg)).toBeUndefined();
  });
});

describe("the differ", () => {
  it("plans an index change on a view that keeps its hash as index operations alone", async () => {
    const current = snapshot([stored(H1, [KEY, BY_TITLE])]);
    const changed = { ...BY_TITLE, columns: ["id", "title"] };
    const added = { name: "feed_id_idx", columns: ["id"], unique: false };
    const { operations } = await diff(
      current,
      snapshot([stored(H1, [KEY, changed, added])])
    );
    expect(operations).toEqual([
      { type: "dropIndex", tableName: "feed", indexName: "feed_title_idx" },
      { type: "createIndex", tableName: "feed", index: changed },
      { type: "createIndex", tableName: "feed", index: added },
    ]);
    expect(
      (await diff(current, snapshot([stored(H1, [BY_TITLE])]))).operations
    ).toEqual([
      { type: "dropIndex", tableName: "feed", indexName: "feed_pkey" },
    ]);
    expect((await diff(current, current)).operations).toEqual([]);
  });

  it("asks the database to spell a view's partial index, as a table's", async () => {
    const asked: [string, readonly string[]][] = [];
    const partial = { ...BY_TITLE, where: "views > 1" };
    const { operations } = await diff(
      snapshot([stored(H1, [{ ...partial, where: "(views > 1)" }])]),
      snapshot([stored(H1, [partial])]),
      {
        canonicalizeIndexPredicate: async (relation, predicates) => {
          asked.push([relation, predicates]);
          return predicates.map(() => "(views > 1)");
        },
      }
    );
    expect(asked).toEqual([["feed", ["(views > 1)", "views > 1"]]]);
    expect(operations).toEqual([]);
  });

  it("replaces a view whose hash changed, its kind read from the side that holds it, with no index operation", async () => {
    const replaced = await diff(
      snapshot([stored(H1, [KEY])]),
      snapshot([stored(H2, [KEY, BY_TITLE])])
    );
    expect(replaced.operations).toEqual([
      { type: "dropView", viewName: "feed", materialized: true },
      { type: "createView", view: stored(H2, [KEY, BY_TITLE]) },
    ]);
    // Ordinary to materialized and back: each drop is of the kind it drops.
    expect(
      (await diff(snapshot([ordinary(H1)]), snapshot([stored(H2)]))).operations
    ).toEqual([
      { type: "dropView", viewName: "feed" },
      { type: "createView", view: stored(H2) },
    ]);
    expect(
      (await diff(snapshot([stored(H2)]), snapshot([ordinary(H1)]))).operations
    ).toEqual([
      { type: "dropView", viewName: "feed", materialized: true },
      { type: "createView", view: ordinary(H1) },
    ]);
  });

  it("from declarations: a new index plans its creation alone, a new kind the replacement", async () => {
    const pg = getMigrationDriver(pgEstateDriver("public"));
    const before = feedSnapshot({ materialized: true });
    const indexed = feedSnapshot({
      materialized: true,
      indexes: [[["title"]]],
    });
    const program = async (from: SchemaSnapshot, to: SchemaSnapshot) =>
      prepareSchemaProgram((await diff(from, to)).operations, from, to, pg);
    expect(await program(before, indexed)).toEqual([
      {
        type: "createIndex",
        tableName: "feed",
        index: feedOf(indexed).indexes!.at(-1),
      },
    ]);
    const plain = feedSnapshot({});
    expect((await program(plain, indexed)).map(({ type }) => type)).toEqual([
      "dropView",
      "createView",
    ]);
  });
});

describe("the program rule", () => {
  const retype: DiffOperation = {
    type: "alterColumn",
    tableName: "posts",
    columnName: "title",
    from: { name: "title", type: "text", nullable: false },
    to: { name: "title", type: "varchar(10)", nullable: false },
  };

  it("replaces a materialized view around a change it does not survive, its indexes with it, never beside it", () => {
    const current = snapshot([stored(H1, [KEY])]);
    const desired = snapshot([stored(H1, [KEY, BY_TITLE])]);
    const indexOnly: DiffOperation = {
      type: "createIndex",
      tableName: "feed",
      index: BY_TITLE,
    };
    expect(
      withViewReplacements([retype, indexOnly], current, desired, false)
    ).toEqual([
      { type: "dropView", viewName: "feed", materialized: true },
      retype,
      { type: "createView", view: desired.views[0] },
    ]);
    // Without a change under it, the index operation is the program.
    expect(withViewReplacements([indexOnly], current, desired, false)).toEqual([
      indexOnly,
    ]);
  });

  it("keeps a materialized view through an added column, as it keeps its stored rows", () => {
    const current = snapshot([stored(H1)]);
    const add: DiffOperation = {
      type: "addColumn",
      tableName: "posts",
      column: { name: "body", type: "text", nullable: true },
    };
    expect(withViewReplacements([add], current, current, false)).toEqual([add]);
  });

  it("orders a view on a materialized view, and the reverse, as views", () => {
    const base = stored(H1, [KEY], "a_base");
    const reader = { ...ordinary(H2, "b_reader"), dependsOn: ["a_base"] };
    const top = { ...stored(H2, [], "c_top"), dependsOn: ["b_reader"] };
    const current = snapshot([base, reader, top]);
    expect(
      withViewReplacements([retype], current, current, false).map(
        (operation) =>
          operation.type === "dropView"
            ? `drop ${operation.viewName}${operation.materialized ? " (m)" : ""}`
            : operation.type === "createView"
              ? `create ${operation.view.name}`
              : operation.type
      )
    ).toEqual([
      "drop c_top (m)",
      "drop b_reader",
      "drop a_base (m)",
      "alterColumn",
      "create a_base",
      "create b_reader",
      "create c_top",
    ]);
  });
});

describe("DDL and probes", () => {
  const pg = getMigrationDriver(pgEstateDriver("billing"));
  const feed = stored(H1, [KEY, { ...BY_TITLE, type: "hash" }]);

  it("creates a materialized view with its data, then its indexes, and drops it as one", () => {
    expect(
      pg.compileStatements(
        { type: "createView", view: feed },
        ddlContext("artifact")
      )
    ).toEqual([
      `CREATE MATERIALIZED VIEW "billing"."feed" AS SELECT * FROM (SELECT "id", "title" FROM "posts") AS "viborm_view_${H1}" WITH DATA`,
      'CREATE UNIQUE INDEX "feed_pkey" ON "billing"."feed" ("id")',
      'CREATE INDEX "feed_title_idx" ON "billing"."feed" USING hash ("title")',
    ]);
    expect(
      pg.compileStatements(
        { type: "dropView", viewName: "feed", materialized: true },
        ddlContext("live")
      )
    ).toEqual(['DROP MATERIALIZED VIEW "billing"."feed"']);
    // An index operation on the view names it as a table's names its table.
    expect(
      pg.compileStatements(
        { type: "createIndex", tableName: "feed", index: BY_TITLE },
        ddlContext("live")
      )
    ).toEqual(['CREATE INDEX "feed_title_idx" ON "billing"."feed" ("title")']);
  });

  it("proves the view's creation by its kind and each index by its own probe", () => {
    const operation: DiffOperation = { type: "createView", view: feed };
    const [create, key, byTitle] = pg.compileStatements(
      operation,
      ddlContext("live")
    );
    const created = probeForGeneratedStatement(pg, operation, create!);
    expect(created?.pre.id).toBe("materialized-view:absent:feed");
    expect(created?.post.sql).toContain("c.relkind = 'm'");
    expect(probeForGeneratedStatement(pg, operation, key!)?.post.id).toBe(
      "index:exists:feed_pkey"
    );
    expect(probeForGeneratedStatement(pg, operation, byTitle!)?.pre.id).toBe(
      "index:absent:feed_title_idx"
    );
    const dropped = probeForGeneratedStatement(
      pg,
      { type: "dropView", viewName: "feed", materialized: true },
      'DROP MATERIALIZED VIEW "billing"."feed"'
    );
    expect(dropped?.post).toMatchObject({
      id: "materialized-view:absent:feed",
      equals: false,
    });
  });

  it("a word INDEX in the body leaves the creation proven as the view's", () => {
    const worded = {
      ...feed,
      sql: `SELECT "id" FROM "posts" WHERE "title" = 'AN INDEX ON X'`,
    };
    const operation: DiffOperation = { type: "createView", view: worded };
    const [create] = pg.compileStatements(operation, ddlContext("live"));
    expect(probeForGeneratedStatement(pg, operation, create!)?.post.id).toBe(
      "materialized-view:exists:feed"
    );
  });

  it("on Neki the creation is planned like an ordinary view's, and its indexes follow in its transaction", () => {
    const add = 'ALTER TABLE "public"."posts" ADD COLUMN "body" text';
    const statements = pg.compileStatements(
      { type: "createView", view: stored(H1, [KEY]) },
      ddlContext("live")
    );
    expect(catalogCommitBoundaries([add, ...statements]).boundaries).toEqual([
      1,
    ]);
    expect(catalogCommitBoundaries(statements).boundaries).toEqual([]);
  });

  it("builds a view's index in place, never as a low-lock step", () => {
    const desired = snapshot([stored(H1, [KEY, BY_TITLE])]);
    const onView: DiffOperation = {
      type: "createIndex",
      tableName: "feed",
      index: BY_TITLE,
    };
    const onTable: DiffOperation = {
      type: "createIndex",
      tableName: "posts",
      index: { name: "posts_title_idx", columns: ["title"], unique: false },
    };
    expect([...lowLockSteps([onView, onTable], desired)]).toEqual([onTable]);
  });
});

describe("inverse", () => {
  it("drops a created materialized view as one, and restores a dropped one or its index from the previous snapshot", () => {
    const previous = snapshot([stored(H1, [KEY, BY_TITLE])]);
    const { operations, warnings } = invertOperations(
      [
        { type: "createView", view: stored(H2) },
        { type: "dropView", viewName: "feed", materialized: true },
        { type: "dropIndex", tableName: "feed", indexName: "feed_title_idx" },
      ],
      previous
    );
    expect(warnings).toEqual([]);
    expect(operations).toEqual([
      { type: "createIndex", tableName: "feed", index: BY_TITLE },
      { type: "createView", view: previous.views[0] },
      { type: "dropView", viewName: "feed", materialized: true },
    ]);
  });
});

describe("collisions and display", () => {
  const marked = ` SELECT id\n   FROM ( SELECT posts.id\n           FROM billing.posts) viborm_view_${H1};`;

  it("takes over a materialized view VibORM marked, and refuses one it did not", () => {
    const declaredTable = { tables: [table("v")] };
    const declaredView = { tables: [], views: [ordinary(H1, "v")] };
    for (const declared of [declaredTable, declaredView])
      refuseRelationCollision(
        "PostgreSQL",
        [declared],
        [{ name: "v", kind: "materialized view", definition: marked }]
      );
    const foreign = {
      name: "v",
      kind: "materialized view",
      definition: " SELECT 1 AS c;",
    } as const;
    expect(() =>
      refuseRelationCollision("PostgreSQL", [declaredTable], [foreign])
    ).toThrow(TABLE_OVER_MATERIALIZED);
    expect(() =>
      refuseRelationCollision("PostgreSQL", [declaredView], [foreign])
    ).toThrow(VIEW_OVER_MATERIALIZED);
  });

  it("says a materialized view is computed by its creation", () => {
    expect(formatOperation({ type: "createView", view: stored(H1) })).toBe(
      '+ Create materialized view "feed" (computed by its CREATE, which runs the whole query; the view is missing until it ends)'
    );
    expect(
      formatOperation({
        type: "dropView",
        viewName: "feed",
        materialized: true,
      })
    ).toBe('- Drop materialized view "feed"');
  });
});
