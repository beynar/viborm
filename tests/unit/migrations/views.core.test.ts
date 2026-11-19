/**
 * Views (`s.view`) in the migration layer, without a database: what the
 * serializer records, what a stored snapshot admits, the identity the
 * fingerprint and the differ give a view, the one program rule that drops and
 * creates a view around a change to what it reads, the order, the inverse,
 * the DDL each driver writes, the marker introspection reads back, the
 * stepwise probes, Neki's commit boundary and the name-collision refusals.
 * The body and identity come from `viewDefinition`, mocked here.
 */

import assert from "node:assert/strict";
import { s } from "@schema";
import { type AnyModel, Model } from "@schema/model";
import type { ViewFacts } from "@schema/view/facts";
import { probeForGeneratedStatement } from "@src/migrations/catalog-probes";
import { diff } from "@src/migrations/differ";
import { getMigrationDriver } from "@src/migrations/drivers";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { snowflakeMigrationDriver } from "@src/migrations/drivers/snowflake";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { surrealMigrationDriver } from "@src/migrations/drivers/surrealql";
import { invertOperations } from "@src/migrations/invert";
import { formatOperation } from "@src/migrations/push/format";
import { fingerprintSnapshot } from "@src/migrations/push-fingerprint";
import { serializeModels } from "@src/migrations/serializer";
import {
  encodeSnapshotArtifact,
  type ResolvedSnapshotArtifact,
  resolveSnapshotArtifacts,
} from "@src/migrations/snapshot-artifacts";
import { catalogCommitBoundaries } from "@src/migrations/statement-safety";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { selectManagedSnapshot } from "@src/migrations/target";
import type {
  DiffOperation,
  SchemaSnapshot,
  TableDef,
  ViewDef,
} from "@src/migrations/types";
import {
  generateMigrationName,
  prepareSchemaProgram,
  sortOperations,
} from "@src/migrations/utils";
import {
  encodeSnapshot,
  parseSnapshotDocument,
} from "@src/migrations/v1-parse-snapshot";
import {
  readViewComment,
  readViewMarker,
  refuseRelationCollision,
  viewMarker,
  withViewReplacements,
  wrappedViewBody,
} from "@src/migrations/view";
import { describe, expect, it, vi } from "vitest";
import { ddlContext, pgEstateDriver } from "./_estate";

/** The definitions `viewDefinition` answers, by the view's physical name. */
const definitions = vi.hoisted(
  () =>
    new Map<
      string,
      { readonly sql: string; readonly hash: string; dependsOn: string[] }
    >()
);
vi.mock("@src/migrations/view-definition", () => ({
  viewDefinition: (view: AnyModel) => {
    const name = view["~"].names.sql ?? "";
    const definition = definitions.get(name);
    if (!definition) throw new Error(`no definition for ${name}`);
    return definition;
  },
}));

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);

const NOT_HEX = /hash must be 40 lowercase hex characters/;
const MISSING_SQL = /is missing sql/;
const UNSORTED_VIEWS = /views must be sorted by name, each name once/;
const EMPTY_VIEWS = /views must be a non-empty array when present/;
const UNSORTED_READS = /dependsOn must be sorted, each name once/;
const UNKNOWN_KEY = /has unknown key/;
const NOT_DECLARED = /does not declare it, so nothing says how to create it/;
const TABLE_OVER_VIEW =
  /relation "v" is a view VibORM did not create, but this schema declares a table/;
const VIEW_OVER_TABLE =
  /relation "v" is a table, but this schema declares a view of that name/;
const VIEW_OVER_FOREIGN_VIEW =
  /relation "v" is a view VibORM did not create, but this schema declares a view/;
const SNOWFLAKE_VIEW = /Snowflake cannot create a view here/;
const SNOWFLAKE_DROP = /Snowflake cannot drop a view here/;
const OUTSIDE_LIST = /declares a view outside the authenticated managed-table/;

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

const view = (
  name: string,
  hash: string,
  dependsOn: string[],
  sql = `SELECT 1 AS "${name}"`
): ViewDef => ({ name, hash, sql, dependsOn });

const snapshot = (tables: TableDef[], views?: ViewDef[]): SchemaSnapshot => ({
  tables,
  ...(views === undefined ? {} : { views }),
});

const kinds = (operations: readonly DiffOperation[]) =>
  operations.map((operation) =>
    operation.type === "createView"
      ? `createView ${operation.view.name}`
      : operation.type === "dropView"
        ? `dropView ${operation.viewName}`
        : operation.type
  );

/** A view of `source` the way `s.view` holds one: its scalars, no relation. */
function viewOf(source: AnyModel, name: string): AnyModel {
  const facts: ViewFacts = { source, query: {}, documents: [] };
  const state = {
    ...source["~"].state,
    relations: {},
    indexes: [],
    tableName: name,
    view: facts,
  };
  return new Model(state);
}

describe("snapshot", () => {
  const post = s.model({ id: s.string().id(), title: s.string() }).map("posts");

  it("serializes a view as its definition, with no table, sorted by name", () => {
    definitions.set("z_view", {
      sql: 'SELECT "id" FROM "posts"',
      hash: H2,
      dependsOn: ["posts"],
    });
    definitions.set("a_view", {
      sql: 'SELECT "title" FROM "posts"',
      hash: H1,
      dependsOn: ["posts"],
    });
    const serialized = serializeModels(
      { post, z: viewOf(post, "z_view"), a: viewOf(post, "a_view") },
      { migrationDriver: postgresMigrationDriver }
    );
    expect(serialized.tables.map(({ name }) => name)).toEqual(["posts"]);
    expect(serialized.views).toEqual([
      {
        name: "a_view",
        hash: H1,
        sql: 'SELECT "title" FROM "posts"',
        dependsOn: ["posts"],
      },
      {
        name: "z_view",
        hash: H2,
        sql: 'SELECT "id" FROM "posts"',
        dependsOn: ["posts"],
      },
    ]);
  });

  it("keeps the bytes, hash and fingerprint of a schema without a view", () => {
    const serialized = serializeModels(
      { post },
      { migrationDriver: postgresMigrationDriver }
    );
    expect("views" in serialized).toBe(false);
    const bare = snapshot([table("posts")]);
    const withUndefined: SchemaSnapshot = { ...bare, views: undefined };
    expect(encodeSnapshot(withUndefined).bytes).toEqual(
      encodeSnapshot(bare).bytes
    );
    expect(new TextDecoder().decode(encodeSnapshot(bare).bytes)).not.toContain(
      "views"
    );
    expect(fingerprintSnapshot(withUndefined, postgresMigrationDriver)).toBe(
      fingerprintSnapshot(bare, postgresMigrationDriver)
    );
  });

  it("a stored snapshot round-trips its views", () => {
    const stored = snapshot(
      [table("posts")],
      [view("a_view", H1, ["posts"]), view("b_view", H2, ["a_view", "posts"])]
    );
    const { bytes, snapshotHash } = encodeSnapshot(stored);
    expect(parseSnapshotDocument(bytes, snapshotHash)).toEqual(stored);
  });

  it("refuses a malformed view", () => {
    const refuses = (views: unknown, message: RegExp) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ tables: [], views })
      );
      // The canonical form of these documents is what JSON.stringify writes.
      const { snapshotHash } = encodeSnapshot({ tables: [] });
      expect(() => parseSnapshotDocument(bytes, snapshotHash)).toThrow(message);
    };
    const valid = {
      dependsOn: ["posts"],
      hash: H1,
      name: "v",
      sql: "SELECT 1",
    };
    refuses([], EMPTY_VIEWS);
    refuses([{ ...valid, hash: "A".repeat(40) }], NOT_HEX);
    refuses([{ ...valid, hash: "1".repeat(64) }], NOT_HEX);
    const { sql: _omitted, ...withoutSql } = valid;
    refuses([withoutSql], MISSING_SQL);
    refuses([{ ...valid, extra: true }], UNKNOWN_KEY);
    refuses([{ ...valid, dependsOn: ["posts", "a"] }], UNSORTED_READS);
    refuses([{ ...valid, dependsOn: ["posts", "posts"] }], UNSORTED_READS);
    refuses([{ ...valid, name: "w" }, valid], UNSORTED_VIEWS);
    refuses([valid, valid], UNSORTED_VIEWS);
  });

  it("the delta encoder carries a view change, and reconstruction restores it", async () => {
    const storage = new MemoryEstateStorage();
    let artifacts = new Map<string, ResolvedSnapshotArtifact>();
    const versions = [
      snapshot([table("posts")]),
      snapshot([table("posts")], [view("b_view", H1, ["posts"])]),
      snapshot(
        [table("posts")],
        [view("a_view", H2, ["posts"]), view("b_view", H1, ["posts"])]
      ),
      snapshot([table("posts")], [view("b_view", H3, ["posts"], "SELECT 2")]),
    ];
    let previous: string | undefined;
    for (const version of versions) {
      const encoded = encodeSnapshotArtifact(
        version,
        artifacts,
        previous ? [previous] : []
      );
      assert.ok(encoded.bytes);
      await storage.publishSnapshot(encoded.artifactHash, encoded.bytes);
      artifacts = await resolveSnapshotArtifacts(
        storage,
        [encoded.artifactHash],
        artifacts
      );
      expect(artifacts.get(encoded.artifactHash)!.snapshot).toEqual(version);
      previous = encoded.artifactHash;
    }
  });

  it("a tables scope names a view as it names a table", () => {
    const live = snapshot(
      [table("posts")],
      [view("kept", H1, ["posts"]), view("other", H2, ["posts"])]
    );
    const target = {
      dialect: "postgresql",
      namespace: "public",
      tables: ["kept", "posts"],
    } as const;
    expect(selectManagedSnapshot(live, target).views).toEqual([
      view("kept", H1, ["posts"]),
    ]);
    expect(
      selectManagedSnapshot(live, { ...target, tables: ["posts"] }).views
    ).toBeUndefined();
    expect(() => selectManagedSnapshot(live, target, true)).toThrow(
      OUTSIDE_LIST
    );
  });
});

describe("identity", () => {
  it("the fingerprint holds a view's name and hash, never its text or reads", () => {
    const base = snapshot([table("posts")], [view("v", H1, ["posts"])]);
    const fingerprint = fingerprintSnapshot(base, postgresMigrationDriver);
    expect(
      fingerprintSnapshot(
        snapshot([table("posts")], [view("v", H1, [], "SELECT 'rewritten'")]),
        postgresMigrationDriver
      )
    ).toBe(fingerprint);
    expect(
      fingerprintSnapshot(
        snapshot([table("posts")], [{ name: "v", hash: H1, dependsOn: [] }]),
        postgresMigrationDriver
      )
    ).toBe(fingerprint);
    expect(
      fingerprintSnapshot(
        snapshot([table("posts")], [view("v", H2, ["posts"])]),
        postgresMigrationDriver
      )
    ).not.toBe(fingerprint);
    expect(
      fingerprintSnapshot(snapshot([table("posts")]), postgresMigrationDriver)
    ).not.toBe(fingerprint);
    // Order free.
    const two = [view("a", H1, []), view("b", H2, [])];
    expect(
      fingerprintSnapshot(snapshot([], two), postgresMigrationDriver)
    ).toBe(
      fingerprintSnapshot(
        snapshot([], [...two].reverse()),
        postgresMigrationDriver
      )
    );
  });

  it("the differ compares hashes: one side only is a create or a drop, a new hash both", async () => {
    const posts = table("posts");
    const plan = async (current: ViewDef[], desired: ViewDef[]) =>
      kinds(
        (await diff(snapshot([posts], current), snapshot([posts], desired)))
          .operations
      );
    expect(await plan([], [view("v", H1, ["posts"])])).toEqual([
      "createView v",
    ]);
    expect(await plan([view("v", H1, ["posts"])], [])).toEqual(["dropView v"]);
    expect(
      await plan([view("v", H1, ["posts"])], [view("v", H2, ["posts"])])
    ).toEqual(["dropView v", "createView v"]);
    // The text is not the identity: an introspected view has none.
    expect(
      await plan(
        [{ name: "v", hash: H1, dependsOn: [] }],
        [view("v", H1, ["posts"])]
      )
    ).toEqual([]);
  });
});

describe("the program rule", () => {
  const posts = table("posts", ["id", "title", "score"]);
  const authors = table("authors");
  const current = snapshot(
    [posts, authors],
    [
      view("feed", H1, ["posts"]),
      view("digest", H2, ["feed"]),
      view("people", H3, ["authors"]),
    ]
  );
  const replaced = (operations: DiffOperation[], rebuilds = true) =>
    kinds(withViewReplacements(operations, current, current, rebuilds));

  const cases: [string, DiffOperation][] = [
    ["renameTable", { type: "renameTable", from: "posts", to: "articles" }],
    ["dropTable", { type: "dropTable", tableName: "posts" }],
    [
      "addColumn",
      {
        type: "addColumn",
        tableName: "posts",
        column: { name: "body", type: "text", nullable: true },
      },
    ],
    [
      "dropColumn",
      { type: "dropColumn", tableName: "posts", columnName: "score" },
    ],
    [
      "renameColumn",
      { type: "renameColumn", tableName: "posts", from: "title", to: "name" },
    ],
    [
      "alterColumn",
      {
        type: "alterColumn",
        tableName: "posts",
        columnName: "score",
        from: { name: "score", type: "integer", nullable: false },
        to: { name: "score", type: "bigint", nullable: false },
      },
    ],
    [
      "dropPrimaryKey",
      { type: "dropPrimaryKey", tableName: "posts", constraintName: "p" },
    ],
    [
      "addPrimaryKey",
      {
        type: "addPrimaryKey",
        tableName: "posts",
        primaryKey: { columns: ["id"] },
      },
    ],
    [
      "addForeignKey",
      {
        type: "addForeignKey",
        tableName: "posts",
        fk: {
          name: "posts_author_fkey",
          columns: ["title"],
          referencedTable: "authors",
          referencedColumns: ["id"],
        },
      },
    ],
    [
      "dropForeignKey",
      { type: "dropForeignKey", tableName: "posts", fkName: "f" },
    ],
    [
      "addUniqueConstraint",
      {
        type: "addUniqueConstraint",
        tableName: "posts",
        constraint: { name: "u", columns: ["title"] },
      },
    ],
    [
      "dropUniqueConstraint",
      { type: "dropUniqueConstraint", tableName: "posts", constraintName: "u" },
    ],
    [
      "alterEnum",
      {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["x"],
        newValues: ["y"],
        dependentColumns: [{ tableName: "posts", columnName: "score" }],
      },
    ],
  ];

  // What a view survives where a table is changed in place (PostgreSQL,
  // MySQL): a column added, a unique or a foreign key changed. Not a primary
  // key: the body orders its rows by it.
  const SURVIVED = new Set([
    "addColumn",
    "addForeignKey",
    "dropForeignKey",
    "addUniqueConstraint",
    "dropUniqueConstraint",
  ]);

  it.each(
    cases
  )("%s on a table a view reads: replaced where the table is rebuilt, and elsewhere only if the view cannot survive it", (name, operation) => {
    expect(replaced([operation], false)).toEqual(
      SURVIVED.has(name)
        ? [operation.type]
        : [
            "dropView digest",
            "dropView feed",
            operation.type,
            "createView feed",
            "createView digest",
          ]
    );
  });

  it("a column that keeps its type is changed under a view, where tables are changed in place", () => {
    const nullability: DiffOperation = {
      type: "alterColumn",
      tableName: "posts",
      columnName: "score",
      from: { name: "score", type: "integer", nullable: false },
      to: { name: "score", type: "integer", nullable: true },
    };
    expect(replaced([nullability], false)).toEqual(["alterColumn"]);
    expect(replaced([nullability])).toEqual([
      "dropView digest",
      "dropView feed",
      "alterColumn",
      "createView feed",
      "createView digest",
    ]);
  });

  it.each(
    cases
  )("%s on a table a view reads replaces it and every view reading it, where tables are rebuilt", (_, operation) => {
    const program = replaced([operation]);
    // The dependent first on the way down, last on the way up; `people`
    // reads another table and stays.
    expect(program).toEqual([
      "dropView digest",
      "dropView feed",
      operation.type,
      "createView feed",
      "createView digest",
    ]);
  });

  it("an index's creation or drop leaves every view as it was", () => {
    expect(
      replaced([
        {
          type: "createIndex",
          tableName: "posts",
          index: { name: "i", columns: ["title"], unique: false },
        },
        { type: "dropIndex", tableName: "posts", indexName: "j" },
      ])
    ).toEqual(["createIndex", "dropIndex"]);
  });

  it("a dropped view takes its readers with it, even ones no table change touches", () => {
    expect(replaced([{ type: "dropView", viewName: "feed" }])).toEqual([
      "dropView digest",
      "dropView feed",
      "createView digest",
    ]);
  });

  it("a view the schema no longer declares is dropped, not created again", () => {
    const desired = snapshot([posts, authors], [view("feed", H1, ["posts"])]);
    const program = prepareSchemaProgram(
      [
        { type: "dropView", viewName: "digest" },
        { type: "dropView", viewName: "people" },
        { type: "renameColumn", tableName: "posts", from: "title", to: "name" },
      ],
      current,
      desired,
      postgresMigrationDriver
    );
    expect(kinds(program)).toEqual([
      "dropView digest",
      "dropView people",
      "dropView feed",
      "renameColumn",
      "createView feed",
    ]);
  });

  it("the declared reads count too: a renamed table named only by the declaration", () => {
    // MySQL and SQLite introspection reads no dependencies; push copies the
    // declared view's, which name the table after the rename.
    const live = snapshot([posts], [{ name: "feed", hash: H1, dependsOn: [] }]);
    const desired = snapshot(
      [{ ...posts, name: "articles" }],
      [view("feed", H1, ["articles"])]
    );
    expect(
      kinds(
        withViewReplacements(
          [{ type: "renameTable", from: "posts", to: "articles" }],
          live,
          desired,
          false
        )
      )
    ).toEqual(["dropView feed", "renameTable", "createView feed"]);
  });

  it("creations follow what they read, drops precede it, whatever the input order", () => {
    const desired = snapshot(
      [posts],
      [
        view("a_top", H1, ["m_mid"]),
        view("m_mid", H2, ["z_base"]),
        view("z_base", H3, ["posts"]),
      ]
    );
    const created = withViewReplacements(
      (desired.views ?? []).map(
        (item): DiffOperation => ({ type: "createView", view: item })
      ),
      snapshot([posts]),
      desired,
      false
    );
    expect(kinds(created)).toEqual([
      "createView z_base",
      "createView m_mid",
      "createView a_top",
    ]);
    const dropped = withViewReplacements(
      ["z_base", "m_mid", "a_top"].map(
        (viewName): DiffOperation => ({ type: "dropView", viewName })
      ),
      desired,
      snapshot([posts]),
      false
    );
    expect(kinds(dropped)).toEqual([
      "dropView a_top",
      "dropView m_mid",
      "dropView z_base",
    ]);
  });

  it("sortOperations runs a view drop before every table and enum operation and a creation after", () => {
    const sorted = sortOperations([
      { type: "createView", view: view("v", H1, ["posts"]) },
      { type: "createEnum", enumDef: { name: "e", values: ["a"] } },
      {
        type: "alterEnum",
        enumName: "e",
        addValues: ["b"],
        newValues: ["a", "b"],
      },
      { type: "dropEnum", enumName: "old" },
      { type: "dropView", viewName: "w" },
    ]);
    expect(kinds(sorted)).toEqual([
      "dropView w",
      "createEnum",
      "alterEnum",
      "dropEnum",
      "createView v",
    ]);
  });

  it("generation and push plan a view around a column type change, through the differ", async () => {
    const from = snapshot([posts], [view("feed", H1, ["posts"])]);
    const to = snapshot(
      [
        {
          ...posts,
          columns: posts.columns.map((column) =>
            column.name === "score" ? { ...column, type: "bigint" } : column
          ),
        },
      ],
      [view("feed", H1, ["posts"])]
    );
    const { operations } = await diff(from, to);
    expect(
      kinds(prepareSchemaProgram(operations, from, to, postgresMigrationDriver))
    ).toEqual(["dropView feed", "alterColumn", "createView feed"]);
  });
});

describe("inverse", () => {
  it("creates what a drop removed, from the previous snapshot, and drops what a creation made", () => {
    const previous = snapshot(
      [table("posts")],
      [view("feed", H1, ["posts"]), view("digest", H2, ["feed"])]
    );
    const forward: DiffOperation[] = [
      { type: "dropView", viewName: "digest" },
      { type: "dropView", viewName: "feed" },
      {
        type: "addColumn",
        tableName: "posts",
        column: { name: "body", type: "text", nullable: true },
      },
      { type: "createView", view: view("feed", H3, ["posts"]) },
      { type: "createView", view: view("digest", H2, ["feed"]) },
    ];
    const { operations, warnings } = invertOperations(forward, previous);
    expect(operations).toEqual([
      { type: "dropView", viewName: "digest" },
      { type: "dropView", viewName: "feed" },
      { type: "dropColumn", tableName: "posts", columnName: "body" },
      { type: "createView", view: view("feed", H1, ["posts"]) },
      { type: "createView", view: view("digest", H2, ["feed"]) },
    ]);
    // A view holds no row: only the dropped column warns.
    expect(warnings).toEqual([]);
    expect(
      invertOperations([{ type: "dropView", viewName: "gone" }], previous)
        .warnings
    ).toEqual([
      'Cannot invert dropView "gone": view not found in previous snapshot.',
    ]);
  });
});

describe("DDL and marker", () => {
  const feed = view("feed", H1, ["posts"], 'SELECT "id" FROM "posts"');
  const pg = getMigrationDriver(pgEstateDriver("billing"));

  it("each SQL dialect wraps the body so its marker is the last token", () => {
    expect(
      pg.compileStatements(
        { type: "createView", view: feed },
        ddlContext("artifact")
      )
    ).toEqual([
      `CREATE VIEW "billing"."feed" AS SELECT * FROM (SELECT "id" FROM "posts") AS "viborm_view_${H1}"`,
    ]);
    expect(
      pg.compileStatements(
        { type: "dropView", viewName: "feed" },
        ddlContext("live")
      )
    ).toEqual(['DROP VIEW "billing"."feed"']);
    expect(
      mysqlMigrationDriver.compileStatements(
        { type: "createView", view: feed },
        ddlContext("artifact")
      )
    ).toEqual([
      `CREATE VIEW \`feed\` AS SELECT * FROM (SELECT "id" FROM "posts") AS \`viborm_view_${H1}\``,
    ]);
    expect(
      mysqlMigrationDriver.compileStatements(
        { type: "dropView", viewName: "feed" },
        ddlContext("artifact")
      )
    ).toEqual(["DROP VIEW `feed`"]);
    expect(
      sqlite3MigrationDriver.compileStatements(
        { type: "createView", view: feed },
        ddlContext("live")
      )
    ).toEqual([
      `CREATE VIEW "feed" AS SELECT * FROM (SELECT "id" FROM "posts") AS "viborm_view_${H1}"`,
    ]);
    expect(viewMarker(H1)).toBe(`viborm_view_${H1}`);
  });

  it("a view read back without its body is not created again", () => {
    expect(() =>
      wrappedViewBody({ name: "feed", hash: H1, dependsOn: [] }, (name) => name)
    ).toThrow(NOT_DECLARED);
  });

  it("Snowflake writes no view; SurrealDB a table computed AS SELECT, its marker the comment", () => {
    expect(() =>
      snowflakeMigrationDriver.compileStatements(
        { type: "createView", view: feed },
        ddlContext("live")
      )
    ).toThrow(SNOWFLAKE_VIEW);
    expect(() =>
      snowflakeMigrationDriver.compileStatements(
        { type: "dropView", viewName: "feed" },
        ddlContext("live")
      )
    ).toThrow(SNOWFLAKE_DROP);
    expect(
      surrealMigrationDriver.compileStatements(
        { type: "createView", view: feed },
        ddlContext("live")
      )
    ).toEqual([
      `DEFINE TABLE feed AS SELECT "id" FROM "posts" COMMENT "viborm_view_${H1}";`,
    ]);
    expect(
      surrealMigrationDriver.compileStatements(
        { type: "dropView", viewName: "feed" },
        ddlContext("live")
      )
    ).toEqual(["REMOVE TABLE feed;"]);
    expect(() =>
      surrealMigrationDriver.compileStatements(
        { type: "createView", view: { ...feed, sql: undefined } },
        ddlContext("live")
      )
    ).toThrow(NOT_DECLARED);
    expect(readViewComment(viewMarker(H1))).toBe(H1);
    expect(readViewComment(`${viewMarker(H1)} `)).toBeUndefined();
    expect(readViewComment(viewMarker("A".repeat(40)))).toBeUndefined();
  });

  it("reads the marker each catalog prints at the end, and nothing inside the body", () => {
    // Measured on PostgreSQL 18 / PGlite (pg_get_viewdef), MySQL 8.4
    // (VIEW_DEFINITION) and SQLite 3.53 (sqlite_master.sql).
    const postgres = ` SELECT id\n   FROM ( SELECT t.id,\n            'x) viborm_view_${H2}'::text AS s\n           FROM billing.t) viborm_view_${H1};`;
    const mysql = `select \`viborm_view_${H1}\`.\`id\` AS \`id\` from (select \`db\`.\`t\`.\`id\` AS \`id\`,'x) viborm_view_${H2}' AS \`s\` from \`db\`.\`t\`) \`viborm_view_${H1}\``;
    const sqlite = `CREATE VIEW "v" AS SELECT * FROM (SELECT "t"."id", 'x) viborm_view_${H2}' AS "s" FROM "t") AS "viborm_view_${H1}"`;
    for (const definition of [postgres, mysql, sqlite])
      expect(readViewMarker(definition)).toBe(H1);
    for (const definition of [
      "SELECT 1 AS c",
      `SELECT 'x) viborm_view_${H1}' AS c`,
      `SELECT * FROM (SELECT 1) AS "viborm_view_${"ab".repeat(20).toUpperCase()}"`,
      `SELECT * FROM (SELECT 1) AS "viborm_view_${H1.slice(1)}"`,
      null,
      undefined,
    ])
      expect(readViewMarker(definition)).toBeUndefined();
  });

  it("each step is proven by its view probe", () => {
    const create = probeForGeneratedStatement(
      pg,
      { type: "createView", view: feed },
      "CREATE VIEW …"
    );
    expect(create?.pre.id).toBe("view:absent:feed");
    expect(create?.post.id).toBe("view:exists:feed");
    expect(create?.post.sql).toContain("c.relkind = 'v'");
    expect(create?.post.parameters).toEqual([
      { kind: "string", value: "billing" },
      { kind: "string", value: "feed" },
    ]);
    const drop = probeForGeneratedStatement(
      sqlite3MigrationDriver,
      { type: "dropView", viewName: "feed" },
      'DROP VIEW "feed"'
    );
    expect(drop?.pre).toMatchObject({ id: "view:exists:feed", equals: true });
    expect(drop?.post).toMatchObject({ id: "view:absent:feed", equals: false });
    expect(drop?.post.sql).toContain("type = 'view'");
  });

  it("on Neki a view's creation is planned: a commit before it after an unseen change", () => {
    const add = 'ALTER TABLE "public"."posts" ADD COLUMN "body" text';
    const create = `CREATE VIEW "public"."feed" AS SELECT * FROM (SELECT "body" FROM "public"."posts") AS "viborm_view_${H1}"`;
    expect(catalogCommitBoundaries([add, create]).boundaries).toEqual([1]);
    expect(catalogCommitBoundaries([create]).boundaries).toEqual([]);
    // A view reading one the transaction just created needs it committed too.
    expect(catalogCommitBoundaries([create, create]).boundaries).toEqual([1]);
  });
});

describe("name collisions", () => {
  const declaredView = snapshot([table("posts")], [view("v", H1, ["posts"])]);
  const declaredTable = snapshot([table("v")]);
  const marked = `CREATE VIEW "v" AS SELECT * FROM (SELECT 1) AS "viborm_view_${H1}"`;

  it("refuses a declared table over a view VibORM did not create", () => {
    expect(() =>
      refuseRelationCollision(
        "SQLite",
        [declaredTable],
        [{ name: "v", kind: "view", definition: 'CREATE VIEW "v" AS SELECT 1' }]
      )
    ).toThrow(TABLE_OVER_VIEW);
    // A marked view is VibORM's: the program drops it before the table.
    refuseRelationCollision(
      "SQLite",
      [declaredTable],
      [{ name: "v", kind: "view", definition: marked }]
    );
  });

  it("refuses a declared view over a table no snapshot declares, or a view VibORM did not create", () => {
    expect(() =>
      refuseRelationCollision(
        "PostgreSQL",
        [declaredView],
        [{ name: "v", kind: "table" }]
      )
    ).toThrow(VIEW_OVER_TABLE);
    expect(() =>
      refuseRelationCollision(
        "MySQL",
        [declaredView],
        [{ name: "v", kind: "view", definition: "select 1 AS `c`" }]
      )
    ).toThrow(VIEW_OVER_FOREIGN_VIEW);
    // Its own marked view, and a table the history declares before the view.
    refuseRelationCollision(
      "MySQL",
      [declaredView],
      [{ name: "v", kind: "view", definition: marked }]
    );
    refuseRelationCollision(
      "PostgreSQL",
      [declaredTable, declaredView],
      [{ name: "v", kind: "table" }]
    );
  });
});

describe("display", () => {
  it("formats and names a view's operations", () => {
    const created: DiffOperation = {
      type: "createView",
      view: view("feed", H1, ["posts"]),
    };
    const dropped: DiffOperation = { type: "dropView", viewName: "feed" };
    expect(formatOperation(created)).toBe('+ Create view "feed"');
    expect(formatOperation(dropped)).toBe('- Drop view "feed"');
    expect(generateMigrationName([created])).toBe("create-view-feed");
    expect(generateMigrationName([dropped, created])).toBe("drop-view-feed");
    expect(
      generateMigrationName([
        created,
        { type: "dropTable", tableName: "posts" },
      ])
    ).toBe("migration");
  });
});
