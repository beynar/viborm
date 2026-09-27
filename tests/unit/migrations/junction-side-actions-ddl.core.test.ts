/**
 * Issue #46 — each junction foreign key carries its OWN side's actions.
 *
 * The serializer used to write one action pair onto both generated foreign
 * keys. Each resolved junction side now carries its actions, and the canonical
 * physical reorder moves a side as a whole: table, columns, referenced columns
 * and actions together. These cells pin the snapshot, the rendered DDL of all
 * three dialects, and the two diffs the plan names: moving the one
 * configuration to the other endpoint changes nothing, and changing one side's
 * policy replaces that side's key alone.
 *
 * Symmetric shorthand DDL is pinned against the frozen pre-change baseline by
 * `relation-ddl-preservation.core.test.ts`; here, only that an equal side map
 * and the shorthand are one snapshot.
 */

import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { diff } from "@src/migrations/differ";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import type { ForeignKeyDef, TableDef } from "@src/migrations/types";
import { hydrateSchemaNames } from "@src/schema/hydration";
import type { JunctionSideActions } from "@src/schema/relation/types";
import { ddlContext } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

const DIALECTS = {
  postgres: postgresMigrationDriver,
  mysql: mysqlMigrationDriver,
  sqlite: sqlite3MigrationDriver,
} as const;

function snapshotOf(
  schema: Record<string, AnyModel>,
  dialect: keyof typeof DIALECTS = "postgres"
) {
  hydrateSchemaNames(schema);
  return serializeModels(schema, { migrationDriver: DIALECTS[dialect] });
}

function tableOf(
  schema: Record<string, AnyModel>,
  name: string,
  dialect: keyof typeof DIALECTS = "postgres"
): TableDef {
  const table = snapshotOf(schema, dialect).tables.find(
    (candidate) => candidate.name === name
  );
  if (table === undefined) throw new Error(`no table '${name}'`);
  return table;
}

/** Each foreign key keyed by the table it references. */
function keysByReferencedTable(
  table: TableDef
): Record<string, Pick<ForeignKeyDef, "columns" | "onDelete" | "onUpdate">> {
  return Object.fromEntries(
    table.foreignKeys.map((key) => [
      key.referencedTable,
      { columns: key.columns, onDelete: key.onDelete, onUpdate: key.onUpdate },
    ])
  );
}

/**
 * `post` owns the junction and sorts SECOND, so the physical first side is
 * `label`: an alphabetical reading of `source` would put `cascade` on the
 * label key.
 */
const ownedByPost = (
  onDelete: JunctionSideActions = { source: "cascade", target: "noAction" },
  onUpdate: JunctionSideActions = { source: "cascade", target: "restrict" }
) => {
  const label = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
  const post = s.model({
    id: s.string().id(),
    labels: s
      .toMany(() => label)
      .onDelete(onDelete)
      .onUpdate(onUpdate),
  });
  return { label, post };
};

const ownedByLabel = () => {
  const label = s.model({
    id: s.string().id(),
    posts: s
      .toMany(() => post)
      .onDelete({ source: "noAction", target: "cascade" })
      .onUpdate({ source: "restrict", target: "cascade" }),
  });
  const post = s.model({ id: s.string().id(), labels: s.toMany(() => label) });
  return { label, post };
};

describe("the snapshot attaches each action to its complete key (witness: PostgreSQL/MySQL/SQLite DDL)", () => {
  for (const dialect of Object.keys(DIALECTS) as (keyof typeof DIALECTS)[]) {
    it(`${dialect}: the declaring model's key cascades, the target's key protects`, () => {
      const junction = tableOf(ownedByPost(), "label_post", dialect);
      expect(junction.columns.map((column) => column.name)).toEqual([
        "labelId",
        "postId",
      ]);
      expect(keysByReferencedTable(junction)).toEqual({
        label: {
          columns: ["labelId"],
          onDelete: "noAction",
          onUpdate: "restrict",
        },
        post: { columns: ["postId"], onDelete: "cascade", onUpdate: "cascade" },
      });
    });
  }

  it("renders each dialect's DDL with the action on the right constraint", () => {
    const rendered = (dialect: keyof typeof DIALECTS) =>
      DIALECTS[dialect].generateDDL(
        {
          type: "createTable",
          table: tableOf(ownedByPost(), "label_post", dialect),
        },
        ddlContext("artifact")
      );
    const postgres = rendered("postgres");
    expect(postgres).toContain(
      'ALTER TABLE "label_post" ADD CONSTRAINT "label_post_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "label" ("id") ON DELETE NO ACTION ON UPDATE RESTRICT'
    );
    expect(postgres).toContain(
      'ALTER TABLE "label_post" ADD CONSTRAINT "label_post_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post" ("id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
    const mysql = rendered("mysql");
    expect(mysql).toContain(
      "CONSTRAINT `label_post_labelId_fkey` FOREIGN KEY (`labelId`) REFERENCES `label` (`id`) ON UPDATE RESTRICT,"
    );
    expect(mysql).toContain(
      "CONSTRAINT `label_post_postId_fkey` FOREIGN KEY (`postId`) REFERENCES `post` (`id`) ON DELETE CASCADE ON UPDATE CASCADE"
    );
    const sqlite = rendered("sqlite");
    expect(sqlite).toContain(
      'CONSTRAINT "label_post_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "label" ("id") ON UPDATE RESTRICT,'
    );
    expect(sqlite).toContain(
      'CONSTRAINT "label_post_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post" ("id") ON DELETE CASCADE ON UPDATE CASCADE'
    );
  });

  it("moves an action with every column of a compound side", () => {
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => zPost) });
    const zPost = s
      .model({
        tenantId: s.string(),
        id: s.string(),
        tags: s
          .toMany(() => tag)
          .onDelete({ source: "restrict", target: "cascade" })
          .onUpdate({ source: "cascade", target: "noAction" }),
      })
      .id(["tenantId", "id"]);
    const junction = tableOf({ tag, zPost }, "tag_zpost");
    expect(keysByReferencedTable(junction)).toEqual({
      tag: { columns: ["tagId"], onDelete: "cascade", onUpdate: "noAction" },
      zPost: {
        columns: ["zpost_1", "zpost_2"],
        onDelete: "restrict",
        onUpdate: "cascade",
      },
    });
  });

  it("keeps an unstated action at the junction default, cascade, per side", () => {
    const junction = tableOf(
      (() => {
        const label = s.model({
          id: s.string().id(),
          posts: s.toMany(() => post),
        });
        const post = s.model({
          id: s.string().id(),
          labels: s
            .toMany(() => label)
            .onDelete({ source: "restrict", target: "noAction" }),
        });
        return { label, post };
      })(),
      "label_post"
    );
    expect(keysByReferencedTable(junction)).toEqual({
      label: {
        columns: ["labelId"],
        onDelete: "noAction",
        onUpdate: "cascade",
      },
      post: { columns: ["postId"], onDelete: "restrict", onUpdate: "cascade" },
    });
  });

  it("gives an equal side map and the symmetric shorthand one snapshot", () => {
    const shorthand = () => {
      const label = s.model({
        id: s.string().id(),
        posts: s.toMany(() => post),
      });
      const post = s.model({
        id: s.string().id(),
        labels: s
          .toMany(() => label)
          .onDelete("restrict")
          .onUpdate("noAction"),
      });
      return { label, post };
    };
    for (const dialect of Object.keys(DIALECTS) as (keyof typeof DIALECTS)[]) {
      expect(
        snapshotOf(
          ownedByPost(
            { source: "restrict", target: "restrict" },
            { source: "noAction", target: "noAction" }
          ),
          dialect
        )
      ).toEqual(snapshotOf(shorthand(), dialect));
    }
  });

  /** Each foreign key keyed by its first column, for keys to one table. */
  const keysByColumn = (table: TableDef) =>
    Object.fromEntries(
      table.foreignKeys.map((key) => [
        key.columns[0],
        { onDelete: key.onDelete, onUpdate: key.onUpdate },
      ])
    );

  /** The one junction of a single-model self relation. */
  const selfJunctionDeclaredOn = (owner: "following" | "followers") => {
    const following = s.toMany(() => node).name("Follows");
    const followers = s.toMany(() => node).name("Follows");
    const node = s.model({
      id: s.string().id(),
      following:
        owner === "following"
          ? following
              .onDelete({ source: "cascade", target: "restrict" })
              .onUpdate({ source: "noAction", target: "cascade" })
          : following,
      followers:
        owner === "followers"
          ? followers
              .onDelete({ source: "restrict", target: "cascade" })
              .onUpdate({ source: "cascade", target: "noAction" })
          : followers,
    });
    return { node };
  };

  for (const dialect of Object.keys(DIALECTS) as (keyof typeof DIALECTS)[]) {
    it(`${dialect}: a self junction declared from either slot is one snapshot, each action on its own column`, () => {
      const fromFollowing = snapshotOf(
        selfJunctionDeclaredOn("following"),
        dialect
      );
      expect(snapshotOf(selfJunctionDeclaredOn("followers"), dialect)).toEqual(
        fromFollowing
      );
      const junctions = fromFollowing.tables.filter(
        (table) => table.name !== "node"
      );
      expect(junctions).toHaveLength(1);
      // Declared on `following`, its own side is the `followingId` column.
      expect(keysByColumn(junctions[0]!)).toEqual({
        followingId: { onDelete: "cascade", onUpdate: "noAction" },
        followersId: { onDelete: "restrict", onUpdate: "cascade" },
      });
    });
  }

  it("keeps each of several junctions between the same models to its own keys", () => {
    const post = s.model({
      id: s.string().id(),
      tagged: s
        .toMany(() => tag)
        .name("tagged")
        .onDelete({ source: "cascade", target: "restrict" }),
      pinned: s
        .toMany(() => tag)
        .name("pinned")
        .onDelete({ source: "restrict", target: "cascade" }),
    });
    const tag = s.model({
      id: s.string().id(),
      taggedPosts: s.toMany(() => post).name("tagged"),
      pinnedPosts: s.toMany(() => post).name("pinned"),
    });
    const junctions = snapshotOf({ post, tag }).tables.filter(
      (table) => table.name !== "post" && table.name !== "tag"
    );
    expect(
      Object.fromEntries(
        junctions.map((table) => [
          table.name,
          Object.fromEntries(
            table.foreignKeys.map((key) => [key.referencedTable, key.onDelete])
          ),
        ])
      )
    ).toEqual({
      post_tag_pinned: { post: "restrict", tag: "cascade" },
      post_tag_tagged: { post: "cascade", tag: "restrict" },
    });
  });

  it("leaves a variant member junction's keys at cascade", () => {
    const article = s.model({
      id: s.string().id(),
      notes: s.toMany(() => note).name("subject"),
    });
    const note = s.model({
      id: s.string().id(),
      subject: s.toMany({ article: () => article }).name("subject"),
    });
    const member = tableOf({ article, note }, "note_subject_article");
    for (const key of member.foreignKeys) {
      expect([key.onDelete, key.onUpdate]).toEqual(["cascade", "cascade"]);
    }
  });
});

describe("migration diffs (witness: owner inversion is a no-op, only a changed key moves)", () => {
  for (const dialect of Object.keys(DIALECTS) as (keyof typeof DIALECTS)[]) {
    it(`${dialect}: the configuration moved to the other endpoint diffs to nothing`, async () => {
      const result = await diff(
        snapshotOf(ownedByPost(), dialect),
        snapshotOf(ownedByLabel(), dialect)
      );
      expect(result.operations).toEqual([]);
    });

    it(`${dialect}: changing one side's action replaces that side's key alone`, async () => {
      const result = await diff(
        snapshotOf(ownedByPost(), dialect),
        snapshotOf(
          ownedByPost({ source: "cascade", target: "restrict" }),
          dialect
        )
      );
      expect(
        result.operations.map((operation) => ({
          type: operation.type,
          table: "tableName" in operation ? operation.tableName : undefined,
          key:
            operation.type === "dropForeignKey"
              ? operation.fkName
              : operation.type === "addForeignKey"
                ? operation.fk.name
                : undefined,
        }))
      ).toEqual([
        {
          type: "dropForeignKey",
          table: "label_post",
          key: "label_post_labelId_fkey",
        },
        {
          type: "addForeignKey",
          table: "label_post",
          key: "label_post_labelId_fkey",
        },
      ]);
    });
  }
});
