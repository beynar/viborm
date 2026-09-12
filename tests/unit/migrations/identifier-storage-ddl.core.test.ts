/**
 * The physical identifier, on all three dialects.
 *
 * One declared format, three storages — and the column a migration creates has
 * to be the column the engine writes into, which is why both derive from the
 * same `idStorageOf`. This file pins what each dialect emits for a declared
 * key, for the foreign keys that DERIVE from it, for junction and polymorphic
 * carrier columns (which carry the referenced key's own scalar), and for a
 * native override that opts back out to text.
 *
 * It also pins the two facts a byte-sensitive differ depends on: an unchanged
 * declaration produces no diff at all, and MySQL's keyed-TEXT widening does not
 * reach a binary column.
 */

import { s } from "@schema";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import { diff } from "@src/migrations/differ";
import type { MigrationDriver } from "@src/migrations/drivers";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import type { ColumnDef, SchemaSnapshot } from "@src/migrations/types";
import { describe, expect, test } from "vitest";

const drivers = [
  postgresMigrationDriver,
  mysqlMigrationDriver,
  sqlite3MigrationDriver,
] as const;

function identifierSchema() {
  const author = s
    .model({
      id: s.string().id().uuid("usr"),
      handle: s.string().nanoid(12).unique(),
      posts: s.toMany(() => post),
      tags: s.toMany(() => tag),
    })
    .map("ids_authors");
  const post = s
    .model({
      id: s.string().id().ksuid(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("ids_posts");
  const tag = s
    .model({
      id: s.string().id().ulid(),
      name: s.string(),
      authors: s.toMany(() => author),
    })
    .map("ids_tags");
  return { author, post, tag };
}

function snapshotFor(driver: MigrationDriver): SchemaSnapshot {
  return serializeModels(identifierSchema(), { migrationDriver: driver });
}

function tableOf(snapshot: SchemaSnapshot, name: string) {
  const table = snapshot.tables.find((entry) => entry.name === name);
  if (!table) throw new Error(`no table '${name}' serialized`);
  return table;
}

function columnsOf(driver: MigrationDriver, table: string) {
  return new Map(
    tableOf(snapshotFor(driver), table).columns.map((column) => [
      column.name,
      column,
    ])
  );
}

describe("a declared key's physical type", () => {
  test("PostgreSQL gives a uuid format its own type and everything else bytea", () => {
    expect(
      columnsOf(postgresMigrationDriver, "ids_authors").get("id")?.type
    ).toBe("uuid");
    expect(columnsOf(postgresMigrationDriver, "ids_tags").get("id")?.type).toBe(
      "bytea"
    );
    expect(
      columnsOf(postgresMigrationDriver, "ids_posts").get("id")?.type
    ).toBe("bytea");
  });

  test("MySQL sizes the binary column to the format's own width", () => {
    expect(columnsOf(mysqlMigrationDriver, "ids_authors").get("id")?.type).toBe(
      "BINARY(16)"
    );
    expect(columnsOf(mysqlMigrationDriver, "ids_tags").get("id")?.type).toBe(
      "BINARY(16)"
    );
    expect(columnsOf(mysqlMigrationDriver, "ids_posts").get("id")?.type).toBe(
      "BINARY(20)"
    );
  });

  test("SQLite stores every compact format as a BLOB", () => {
    for (const table of ["ids_authors", "ids_posts", "ids_tags"]) {
      expect(columnsOf(sqlite3MigrationDriver, table).get("id")?.type).toBe(
        "BLOB"
      );
    }
  });

  test("a text format keeps the text column it always had", () => {
    expect(
      columnsOf(postgresMigrationDriver, "ids_authors").get("handle")?.type
    ).toBe("text");
    expect(
      columnsOf(sqlite3MigrationDriver, "ids_authors").get("handle")?.type
    ).toBe("TEXT");
  });

  test("an ordinary string is untouched by any of it", () => {
    expect(
      columnsOf(postgresMigrationDriver, "ids_posts").get("title")?.type
    ).toBe("text");
  });
});

describe("a derived column is the column it references", () => {
  test("a foreign key takes its target key's physical type", () => {
    for (const driver of drivers) {
      const columns = columnsOf(driver, "ids_posts");
      const target = columnsOf(driver, "ids_authors");
      expect(columns.get("authorId")?.type).toBe(target.get("id")?.type);
    }
  });

  test("a junction column takes the primary key's physical type", () => {
    for (const driver of drivers) {
      const snapshot = snapshotFor(driver);
      const junction = snapshot.tables.find(
        (table) =>
          table.name !== "ids_authors" &&
          table.name !== "ids_posts" &&
          table.name !== "ids_tags"
      );
      if (!junction) {
        throw new Error(
          `no junction table serialized; saw ${snapshot.tables
            .map((table) => table.name)
            .join(", ")}`
        );
      }
      const authorKey = columnsOf(driver, "ids_authors").get("id")?.type;
      const tagKey = columnsOf(driver, "ids_tags").get("id")?.type;
      const types = junction.columns.map((column) => column.type).sort();
      expect(types).toEqual([authorKey, tagKey].sort());
    }
  });

  test("a polymorphic carrier's id column takes the variants' shared type", () => {
    const thread = s.model({ id: s.string().id().uuid() }).map("ids_threads");
    const review = s.model({ id: s.string().id().uuid() }).map("ids_reviews");
    const topic = s
      .model({
        id: s.string().id(),
        subject: s.toOne(
          { thread: () => thread, review: () => review },
          { values: { thread: "t.v1", review: "r.v1" } }
        ),
      })
      .map("ids_topics");
    for (const driver of drivers) {
      const snapshot = serializeModels(
        { thread, review, topic },
        { migrationDriver: driver }
      );
      const carrier = tableOf(snapshot, "ids_topics").columns.find((column) =>
        column.name.endsWith("_id")
      );
      const key = tableOf(snapshot, "ids_threads").columns.find(
        (column) => column.name === "id"
      );
      expect(carrier?.type).toBe(key?.type);
    }
  });
});

describe("a native type override", () => {
  const overridden = (native: Parameters<typeof s.string>[0]) => ({
    only: s.model({ id: s.string(native).id().uuid("usr") }).map("ids_only"),
  });

  test("a text-family override opts back out of compact storage", () => {
    expect(
      serializeModels(overridden(PG.STRING.VARCHAR(40)), {
        migrationDriver: postgresMigrationDriver,
      }).tables[0]?.columns[0]?.type
    ).toBe("varchar(40)");
    expect(
      serializeModels(overridden(SQLITE.STRING.TEXT), {
        migrationDriver: sqlite3MigrationDriver,
      }).tables[0]?.columns[0]?.type
    ).toBe("TEXT");
  });

  test("a binary override of the right width is taken as spelled", () => {
    expect(
      serializeModels(overridden(MYSQL.BLOB.VARBINARY(16)), {
        migrationDriver: mysqlMigrationDriver,
      }).tables[0]?.columns[0]?.type
    ).toBe("VARBINARY(16)");
  });

  test("an override for another dialect leaves the automatic column", () => {
    expect(
      serializeModels(overridden(MYSQL.BLOB.BINARY(16)), {
        migrationDriver: postgresMigrationDriver,
      }).tables[0]?.columns[0]?.type
    ).toBe("uuid");
  });
});

describe("the DDL default", () => {
  const declared = (native?: Parameters<typeof s.string>[0]) => ({
    only: s
      .model({
        id: s
          .string(native)
          .id()
          .uuid(...([] as [])),
      })
      .map("ids_defaults"),
  });

  function defaultOf(
    driver: MigrationDriver,
    models: Record<string, ReturnType<typeof s.model>>
  ): string | undefined {
    return serializeModels(models, { migrationDriver: driver }).tables[0]
      ?.columns[0]?.default;
  }

  test("PostgreSQL generates an unprefixed uuid in its own uuid column", () => {
    expect(defaultOf(postgresMigrationDriver, declared())).toBe(
      "gen_random_uuid()"
    );
  });

  test("…and a text-stored one, which still holds the same spelling", () => {
    expect(defaultOf(postgresMigrationDriver, declared(PG.STRING.TEXT))).toBe(
      "gen_random_uuid()"
    );
  });

  test("…but never a bytea column, which cannot take a uuid value", () => {
    expect(
      defaultOf(postgresMigrationDriver, declared(PG.BLOB.BYTEA))
    ).toBeUndefined();
  });

  test("a prefixed uuid and every other format carry no DDL default", () => {
    const prefixed = {
      only: s.model({ id: s.string().id().uuid("usr") }).map("ids_defaults"),
    };
    const ulid = {
      only: s.model({ id: s.string().id().ulid() }).map("ids_defaults"),
    };
    expect(defaultOf(postgresMigrationDriver, prefixed)).toBeUndefined();
    expect(defaultOf(postgresMigrationDriver, ulid)).toBeUndefined();
  });

  test("a bare `.id()` key carries none either — it names no format", () => {
    const key = {
      only: s.model({ id: s.string().id() }).map("ids_defaults"),
    };
    expect(defaultOf(postgresMigrationDriver, key)).toBeUndefined();
  });
});

describe("what a differ sees", () => {
  test("an unchanged declaration produces no diff on any dialect", async () => {
    for (const driver of drivers) {
      const result = await diff(snapshotFor(driver), snapshotFor(driver));
      expect(result.operations).toEqual([]);
    }
  });

  test("MySQL's keyed-TEXT widening never reaches a binary column", () => {
    // Every `id` below is a primary key, so it is keyed — and `BINARY(n)` must
    // not become `VARCHAR(191)` the way a keyed `TEXT` does.
    const columns = columnsOf(mysqlMigrationDriver, "ids_authors");
    expect(columns.get("id")?.type).toBe("BINARY(16)");
    expect(columns.get("handle")?.type).toBe("VARCHAR(191)");
  });

  test("a compact column carries no new snapshot key", () => {
    const column: ColumnDef | undefined = columnsOf(
      sqlite3MigrationDriver,
      "ids_tags"
    ).get("id");
    expect(Object.keys(column ?? {}).sort()).toEqual(
      [
        "autoIncrement",
        "dateTime",
        "decimal",
        "default",
        "name",
        "nullable",
        "type",
      ].sort()
    );
  });
});
