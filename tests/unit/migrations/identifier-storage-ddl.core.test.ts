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

/**
 * The DERIVED case, which is the one a junction and a carrier get wrong when
 * they read a scalar's own declaration: a one-to-one child whose primary key IS
 * its parent foreign key declares no format and still holds the parent's. Its
 * junction and carrier columns must be the column they reference or the table
 * cannot be keyed at all — PostgreSQL refuses a `text` → `uuid` foreign key
 * outright, and SQLite accepts it and then stores two different things.
 */
describe("a key that DERIVES its domain types its private columns too", () => {
  function derivedSchema() {
    const account = s
      .model({
        id: s.string().id().uuid("usr"),
        profile: s.toOne(() => profile),
      })
      .map("idd_accounts");
    const profile = s
      .model({
        id: s.string().id(),
        account: s
          .toOne(() => account)
          .fields("id")
          .references("id"),
        tags: s.toMany(() => tag),
        notes: s.toMany(() => note).name("subject"),
      })
      .map("idd_profiles");
    const tag = s
      .model({
        id: s.string().id().ulid(),
        profiles: s.toMany(() => profile),
      })
      .map("idd_tags");
    const other = s
      .model({
        id: s.string().id().uuid("usr"),
        notes: s.toMany(() => note).name("subject"),
      })
      .map("idd_others");
    const note = s
      .model({
        id: s.string().id(),
        subject: s
          .toOne(
            { profile: () => profile, other: () => other },
            { values: { profile: "p.v1", other: "o.v1" } }
          )
          .name("subject"),
      })
      .map("idd_notes");
    return { account, profile, tag, other, note };
  }

  const derivedSnapshot = (driver: MigrationDriver) =>
    serializeModels(derivedSchema(), { migrationDriver: driver });

  test("the junction column is the derived key's own column", () => {
    for (const driver of drivers) {
      const snapshot = derivedSnapshot(driver);
      const profileKey = tableOf(snapshot, "idd_profiles").columns.find(
        (column) => column.name === "id"
      )?.type;
      const tagKey = tableOf(snapshot, "idd_tags").columns.find(
        (column) => column.name === "id"
      )?.type;
      const modelTables = new Set([
        "idd_accounts",
        "idd_profiles",
        "idd_tags",
        "idd_others",
        "idd_notes",
      ]);
      const junction = snapshot.tables.find(
        (table) => !modelTables.has(table.name)
      );
      if (!junction) throw new Error("no junction table serialized");
      expect(junction.columns.map((column) => column.type).sort()).toEqual(
        [profileKey, tagKey].sort()
      );
    }
  });

  test("the polymorphic carrier's id column is too", () => {
    for (const driver of drivers) {
      const snapshot = derivedSnapshot(driver);
      const profileKey = tableOf(snapshot, "idd_profiles").columns.find(
        (column) => column.name === "id"
      )?.type;
      const carrier = tableOf(snapshot, "idd_notes").columns.find((column) =>
        column.name.endsWith("_id")
      );
      expect(carrier?.type).toBe(profileKey);
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

/**
 * The one conversion no dialect can perform. Every `ALTER COLUMN` is a blind
 * re-reading of the stored bytes; when the target is a BINARY column the only
 * cast on offer re-encodes the source's own spelling, and the three routes were
 * each silently wrong in their own way — PostgreSQL wrote the ASCII of the old
 * text through `USING col::bytea`, SQLite's rebuild copied it verbatim into a
 * `BLOB`, MySQL truncated or padded to the declared width.
 */
const BINARY_REENCODING_REFUSAL =
  /no dialect can re-read the stored values as bytes/;

describe("a column becoming binary", () => {
  const column = (name: string, type: string): ColumnDef => ({
    name,
    type,
    nullable: false,
  });
  const alter = (
    driver: MigrationDriver,
    from: ColumnDef,
    to: ColumnDef
  ): readonly string[] =>
    driver.compileStatements(
      {
        type: "alterColumn",
        tableName: "ids_things",
        columnName: from.name,
        from,
        to,
      },
      {
        destination: "live",
        currentSchema: {
          tables: [
            {
              name: "ids_things",
              columns: [from],
              indexes: [],
              foreignKeys: [],
              uniqueConstraints: [],
            },
          ],
          enums: [],
        },
      }
    );

  test.each([
    [postgresMigrationDriver, "text", "bytea"],
    [mysqlMigrationDriver, "VARCHAR(191)", "BINARY(16)"],
    [sqlite3MigrationDriver, "TEXT", "BLOB"],
  ] as const)("%# refuses text to binary", (driver, fromType, toType) => {
    expect(() =>
      alter(driver, column("id", fromType), column("id", toType))
    ).toThrowError(BINARY_REENCODING_REFUSAL);
  });

  test("the refusal names the manual route and the text-family opt-out", () => {
    try {
      alter(
        postgresMigrationDriver,
        column("id", "text"),
        column("id", "bytea")
      );
      throw new Error("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Convert the rows yourself");
      expect(message).toContain("text-family native type");
    }
  });

  test("a width change inside the binary family still compiles", () => {
    // Both sides binary re-reads the same bytes as the same bytes, which is the
    // property the refusal requires — it is not a ban on binary columns.
    expect(() =>
      alter(
        mysqlMigrationDriver,
        column("payload", "VARBINARY(100)"),
        column("payload", "VARBINARY(200)")
      )
    ).not.toThrow();
  });

  test("PostgreSQL's uuid target is a real conversion and is left alone", () => {
    // `col::uuid` succeeds for an estate of canonical uuids and aborts the whole
    // transaction for one that is not, leaving the column as it was.
    expect(() =>
      alter(postgresMigrationDriver, column("id", "text"), column("id", "uuid"))
    ).not.toThrow();
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
