/**
 * Issue #45 — a native type per dialect, as each migration driver sees it.
 *
 * One schema declares a map; each dialect's migration driver resolves it
 * through the one bound-dialect resolver (`nativeTypeFor`) and emits only its
 * own entry, or its automatic column when the map omits it. The tagged
 * shorthand keeps byte-identical DDL, and a snapshot records only the physical
 * type its own dialect selected, so another dialect's entry cannot drift it.
 */

import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import type { Scalar } from "@schema/scalars";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import { diff } from "@src/migrations/differ";
import type { MigrationDriver } from "@src/migrations/drivers";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import { describe, expect, test } from "vitest";
import { ddlContext } from "./_estate";

const DRIVERS = {
  pg: postgresMigrationDriver,
  mysql: mysqlMigrationDriver,
  sqlite: sqlite3MigrationDriver,
} as const;

type Dialect = keyof typeof DRIVERS;
type Schema = Record<string, AnyModel>;

const DIALECTS = Object.keys(DRIVERS) as Dialect[];

const snapshot = (schema: Schema, dialect: Dialect) =>
  serializeModels(schema, { migrationDriver: DRIVERS[dialect] });

/** column name → the snapshot column, for one table on one dialect. */
function columnsOf(schema: Schema, dialect: Dialect, table: string) {
  const found = snapshot(schema, dialect).tables.find((t) => t.name === table);
  if (found === undefined) throw new Error(`no table ${table}`);
  return Object.fromEntries(found.columns.map((c) => [c.name, c]));
}

/** One column's type on every dialect. */
function typesOf(schema: Schema, table: string, column: string) {
  return Object.fromEntries(
    DIALECTS.map((dialect) => [
      dialect,
      columnsOf(schema, dialect, table)[column]?.type,
    ])
  );
}

/** The CREATE statements a fresh database would run, on one dialect. */
async function createDDL(schema: Schema, dialect: Dialect): Promise<string[]> {
  const driver: MigrationDriver = DRIVERS[dialect];
  const { operations } = await diff({ tables: [] }, snapshot(schema, dialect));
  return operations.map((operation) =>
    driver.generateDDL(operation, ddlContext("artifact"))
  );
}

const noteWith = (body: Scalar) => ({
  note: s.model({ id: s.string().id(), body }).map("ntm_notes"),
});

describe("one declaration, three columns", () => {
  test("the issue's map selects citext, LONGTEXT and TEXT", () => {
    const schema = noteWith(
      s.string({
        pg: PG.STRING.CITEXT,
        mysql: MYSQL.STRING.LONGTEXT,
        sqlite: SQLITE.STRING.TEXT,
      })
    );
    expect(typesOf(schema, "ntm_notes", "body")).toEqual({
      pg: "citext",
      mysql: "LONGTEXT",
      sqlite: "TEXT",
    });
  });

  test("an omitted dialect keeps its automatic column", () => {
    expect(
      typesOf(
        noteWith(s.string({ mysql: MYSQL.STRING.LONGTEXT })),
        "ntm_notes",
        "body"
      )
    ).toEqual({ pg: "text", mysql: "LONGTEXT", sqlite: "TEXT" });
    expect(
      typesOf(
        noteWith(s.string({ pg: PG.STRING.VARCHAR(80) })),
        "ntm_notes",
        "body"
      )
    ).toEqual({ pg: "varchar(80)", mysql: "TEXT", sqlite: "TEXT" });
  });
});

describe("the tagged shorthand is unchanged", () => {
  // Pinned: what `origin/main` (778912983, before maps existed) emitted for the
  // two shorthands, captured by running this same statement generation there.
  const SHORTHANDS = {
    citext: () => s.string(PG.STRING.CITEXT),
    longtext: () => s.string(MYSQL.STRING.LONGTEXT),
  } as const;
  const PINNED: Record<`${Dialect}:${keyof typeof SHORTHANDS}`, string> = {
    "pg:citext":
      'CREATE TABLE "ntm_notes" (\n  "id" text NOT NULL,\n  "body" citext NOT NULL,\n  CONSTRAINT "ntm_notes_pkey" PRIMARY KEY ("id")\n)',
    "pg:longtext":
      'CREATE TABLE "ntm_notes" (\n  "id" text NOT NULL,\n  "body" text NOT NULL,\n  CONSTRAINT "ntm_notes_pkey" PRIMARY KEY ("id")\n)',
    "mysql:citext":
      "CREATE TABLE `ntm_notes` (\n  `id` VARCHAR(191) NOT NULL,\n  `body` TEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
    "mysql:longtext":
      "CREATE TABLE `ntm_notes` (\n  `id` VARCHAR(191) NOT NULL,\n  `body` LONGTEXT NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin",
    "sqlite:citext":
      'CREATE TABLE "ntm_notes" (\n  "id" TEXT NOT NULL,\n  "body" TEXT NOT NULL,\n  PRIMARY KEY ("id")\n)',
    "sqlite:longtext":
      'CREATE TABLE "ntm_notes" (\n  "id" TEXT NOT NULL,\n  "body" TEXT NOT NULL,\n  PRIMARY KEY ("id")\n)',
  };

  test.each(
    DIALECTS
  )("%s DDL is byte-identical to origin/main", async (dialect) => {
    for (const [label, declare] of Object.entries(SHORTHANDS)) {
      expect(await createDDL(noteWith(declare()), dialect)).toEqual([
        PINNED[`${dialect}:${label as keyof typeof SHORTHANDS}`],
      ]);
    }
  });

  // Every factory that takes a native type, once, on one schema: parameterized
  // constants, SQLite INTEGER / REAL DateTime (with a rendered default), compact
  // identifier storage declared by a shorthand with a foreign key that repeats
  // it, a PostgreSQL list and an enum. Pinned from origin/main (778912983) by
  // running this same generation on a git-archive copy of it.
  const shorthandSchema = () => {
    const owner = s
      .model({
        id: s.string(PG.BLOB.BYTEA).uuid().id(),
        code: s.string(SQLITE.BLOB.BLOB).ulid().unique(),
        handle: s.string(MYSQL.STRING.VARCHAR(80)),
        small: s.int(PG.INT.SMALLINT),
        tiny: s.int(MYSQL.INT.TINYINT),
        big: s.bigInt(MYSQL.BIGINT.BIGINT_UNSIGNED),
        ratio: s.number(PG.FLOAT.REAL),
        flag: s.boolean(MYSQL.BOOLEAN.TINYINT),
        doc: s.json(PG.JSON.JSON),
        bytes: s.blob(MYSQL.BLOB.LONGBLOB),
        embedding: s.vector(PG.STRING.TEXT),
        kind: s.enum(["a", "b"], MYSQL.STRING.VARCHAR(10)),
        seenAt: s
          .dateTime(SQLITE.DATETIME.INTEGER)
          .default("2026-01-01T00:00:00.000Z"),
        stampedAt: s.dateTime(SQLITE.DATETIME.REAL).nullable(),
        at: s.dateTime(PG.DATETIME.TIMESTAMP(3)),
        day: s.date(PG.DATETIME.DATE),
        clock: s.time(MYSQL.DATETIME.TIME(3)),
        tags: s.string(PG.STRING.VARCHAR(20)).array(),
        pets: s.toMany(() => pet),
      })
      .map("ntm_short_owners");
    const pet = s
      .model({
        id: s.string().id(),
        ownerId: s.string(PG.BLOB.BYTEA),
        owner: s
          .toOne(() => owner)
          .fields("ownerId")
          .references("id"),
      })
      .map("ntm_short_pets");
    return { owner, pet };
  };
  const SHORTHAND_PINNED: Record<Dialect, string[]> = {
    pg: [
      "CREATE TYPE \"ntm_short_owners_kind_enum\" AS ENUM ('a', 'b')",
      'CREATE TABLE "ntm_short_owners" (\n  "id" bytea NOT NULL,\n  "code" bytea NOT NULL,\n  "handle" text NOT NULL,\n  "small" smallint NOT NULL,\n  "tiny" integer NOT NULL,\n  "big" bigint NOT NULL,\n  "ratio" real NOT NULL,\n  "flag" boolean NOT NULL,\n  "doc" json NOT NULL,\n  "bytes" bytea NOT NULL,\n  "embedding" text NOT NULL,\n  "kind" ntm_short_owners_kind_enum NOT NULL,\n  "seenAt" timestamptz(3) NOT NULL DEFAULT \'2026-01-01T00:00:00.000Z\',\n  "stampedAt" timestamptz(3),\n  "at" timestamp(3) NOT NULL,\n  "day" date NOT NULL,\n  "clock" time(3) NOT NULL,\n  "tags" varchar(20)[] NOT NULL,\n  CONSTRAINT "ntm_short_owners_pkey" PRIMARY KEY ("id"),\n  CONSTRAINT "ntm_short_owners_code_key" UNIQUE ("code")\n)',
      'CREATE TABLE "ntm_short_pets" (\n  "id" text NOT NULL,\n  "ownerId" bytea NOT NULL,\n  CONSTRAINT "ntm_short_pets_pkey" PRIMARY KEY ("id")\n);\nCREATE INDEX "ntm_short_pets_ownerId_idx" ON "ntm_short_pets" ("ownerId");\nALTER TABLE "ntm_short_pets" ADD CONSTRAINT "ntm_short_pets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "ntm_short_owners" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION',
    ],
    mysql: [
      "-- MySQL: ENUM type is part of column definition",
      "CREATE TABLE `ntm_short_owners` (\n  `id` BINARY(16) NOT NULL,\n  `code` BINARY(16) NOT NULL,\n  `handle` VARCHAR(80) NOT NULL,\n  `small` INT NOT NULL,\n  `tiny` TINYINT NOT NULL,\n  `big` BIGINT UNSIGNED NOT NULL,\n  `ratio` DOUBLE NOT NULL,\n  `flag` TINYINT(1) NOT NULL,\n  `doc` JSON NOT NULL,\n  `bytes` LONGBLOB NOT NULL,\n  `embedding` JSON NOT NULL,\n  `kind` ENUM('a', 'b') NOT NULL,\n  `seenAt` DATETIME(3) NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',\n  `stampedAt` DATETIME(3),\n  `at` DATETIME(3) NOT NULL,\n  `day` DATE NOT NULL,\n  `clock` TIME(3) NOT NULL,\n  `tags` JSON NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;\nCREATE UNIQUE INDEX `ntm_short_owners_code_key` ON `ntm_short_owners` (`code`)",
      "CREATE TABLE `ntm_short_pets` (\n  `id` VARCHAR(191) NOT NULL,\n  `ownerId` BINARY(16) NOT NULL,\n  PRIMARY KEY (`id`),\n  CONSTRAINT `ntm_short_pets_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `ntm_short_owners` (`id`) ON DELETE RESTRICT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;\nCREATE INDEX `ntm_short_pets_ownerId_idx` ON `ntm_short_pets` (`ownerId`)",
    ],
    sqlite: [
      'CREATE TABLE "ntm_short_owners" (\n  "id" BLOB NOT NULL,\n  "code" BLOB NOT NULL,\n  "handle" TEXT NOT NULL,\n  "small" INTEGER NOT NULL,\n  "tiny" INTEGER NOT NULL,\n  "big" INTEGER NOT NULL,\n  "ratio" REAL NOT NULL,\n  "flag" INTEGER NOT NULL,\n  "doc" JSON NOT NULL,\n  "bytes" BLOB NOT NULL,\n  "embedding" JSON NOT NULL,\n  "kind" TEXT CHECK("kind" IN (\'a\', \'b\')) NOT NULL,\n  "seenAt" INTEGER NOT NULL DEFAULT 1767225600000,\n  "stampedAt" REAL DEFAULT NULL,\n  "at" TEXT NOT NULL,\n  "day" TEXT NOT NULL,\n  "clock" TEXT NOT NULL,\n  "tags" JSON NOT NULL,\n  PRIMARY KEY ("id"),\n  CONSTRAINT "ntm_short_owners_code_key" UNIQUE ("code")\n)',
      'CREATE TABLE "ntm_short_pets" (\n  "id" TEXT NOT NULL,\n  "ownerId" BLOB NOT NULL,\n  PRIMARY KEY ("id"),\n  CONSTRAINT "ntm_short_pets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "ntm_short_owners" ("id") ON DELETE RESTRICT\n);\nCREATE INDEX "ntm_short_pets_ownerId_idx" ON "ntm_short_pets" ("ownerId")',
    ],
  };

  test.each(
    DIALECTS
  )("%s: every factory's shorthand preserves physical types with millisecond temporal defaults", async (dialect) => {
    expect(await createDDL(shorthandSchema(), dialect)).toEqual(
      SHORTHAND_PINNED[dialect]
    );
  });

  test.each(
    DIALECTS
  )("%s: a one-entry map and the shorthand emit the same DDL", async (dialect) => {
    for (const [shorthand, map] of [
      [s.string(PG.STRING.CITEXT), s.string({ pg: PG.STRING.CITEXT })],
      [
        s.string(MYSQL.STRING.LONGTEXT),
        s.string({ mysql: MYSQL.STRING.LONGTEXT }),
      ],
    ] as const) {
      expect(await createDDL(noteWith(map), dialect)).toEqual(
        await createDDL(noteWith(shorthand), dialect)
      );
    }
  });
});

describe("representatives", () => {
  const event = (at: Scalar) => ({
    event: s.model({ id: s.string().id(), at }).map("ntm_events"),
  });

  test("DateTime: SQLite INTEGER or REAL beside other dialects' timestamps", () => {
    const epoch = event(
      s.dateTime({
        pg: PG.DATETIME.TIMESTAMP(3),
        mysql: MYSQL.DATETIME.DATETIME(6),
        sqlite: SQLITE.DATETIME.INTEGER,
      })
    );
    expect(typesOf(epoch, "ntm_events", "at")).toEqual({
      pg: "timestamp(3)",
      mysql: "DATETIME(6)",
      sqlite: "INTEGER",
    });
    // The snapshot's SQLite storage marker is derived from the same answer.
    expect(columnsOf(epoch, "sqlite", "ntm_events").at?.dateTime).toBe(
      "epochMillis"
    );
    const julian = event(s.dateTime({ sqlite: SQLITE.DATETIME.REAL }));
    expect(typesOf(julian, "ntm_events", "at")).toEqual({
      pg: "timestamptz(3)",
      mysql: "DATETIME(3)",
      sqlite: "REAL",
    });
    expect(columnsOf(julian, "sqlite", "ntm_events").at?.dateTime).toBe(
      "julianDay"
    );
  });

  test("DateTime default renders in the column's own physical form", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    const mapped = event(
      s
        .dateTime({
          pg: PG.DATETIME.TIMESTAMP(3),
          sqlite: SQLITE.DATETIME.INTEGER,
        })
        .default(iso)
    );
    const plain = event(s.dateTime().default(iso));
    expect(columnsOf(mapped, "sqlite", "ntm_events").at?.default).toBe(
      String(Date.parse(iso))
    );
    expect(columnsOf(mapped, "pg", "ntm_events").at?.default).toBe(
      columnsOf(plain, "pg", "ntm_events").at?.default
    );
    expect(columnsOf(mapped, "mysql", "ntm_events").at?.default).toBe(
      columnsOf(plain, "mysql", "ntm_events").at?.default
    );
  });

  test("compact identifiers and their foreign keys take each dialect's entry", () => {
    const storage = { pg: PG.BLOB.BYTEA, mysql: MYSQL.STRING.VARCHAR(36) };
    const owner = s
      .model({
        id: s.string(storage).uuid().id(),
        pets: s.toMany(() => pet),
      })
      .map("ntm_owners");
    const pet = s
      .model({
        id: s.string().id(),
        ownerId: s.string(storage),
        owner: s
          .toOne(() => owner)
          .fields("ownerId")
          .references("id"),
      })
      .map("ntm_pets");
    const schema = { owner, pet };
    expect(typesOf(schema, "ntm_owners", "id")).toEqual({
      pg: "bytea",
      mysql: "VARCHAR(36)",
      sqlite: "BLOB",
    });
    expect(typesOf(schema, "ntm_pets", "ownerId")).toEqual(
      typesOf(schema, "ntm_owners", "id")
    );
    // A `bytea` uuid column cannot take `gen_random_uuid()`.
    expect(columnsOf(schema, "pg", "ntm_owners").id?.default).toBeUndefined();
  });

  test("string, number, list and enum", () => {
    const shape = s
      .model({
        id: s.string().id(),
        ratio: s.number({ pg: PG.FLOAT.REAL, mysql: MYSQL.FLOAT.FLOAT }),
        tags: s
          .string({
            pg: PG.STRING.VARCHAR(20),
            mysql: MYSQL.STRING.VARCHAR(20),
            sqlite: SQLITE.STRING.TEXT,
          })
          .array(),
        kind: s.enum(["a", "b"], {
          pg: PG.STRING.TEXT,
          mysql: MYSQL.STRING.TEXT,
        }),
      })
      .map("ntm_shapes");
    const plain = s
      .model({
        id: s.string().id(),
        ratio: s.number(),
        tags: s.string().array(),
        kind: s.enum(["a", "b"]),
      })
      .map("ntm_shapes");
    expect(typesOf({ shape }, "ntm_shapes", "ratio")).toEqual({
      pg: "real",
      mysql: "FLOAT",
      sqlite: "REAL",
    });
    // A list's members live in their dialect's container; only PostgreSQL has
    // a native array of the declared member type.
    expect(typesOf({ shape }, "ntm_shapes", "tags")).toEqual({
      ...typesOf({ shape: plain }, "ntm_shapes", "tags"),
      pg: "varchar(20)[]",
    });
    // An enum column is spelled by the enum, as with the tagged shorthand.
    expect(typesOf({ shape }, "ntm_shapes", "kind")).toEqual(
      typesOf({ shape: plain }, "ntm_shapes", "kind")
    );
  });
});

describe("a snapshot holds its own dialect's choice only", () => {
  const versions = {
    first: {
      pg: PG.STRING.VARCHAR(40),
      mysql: MYSQL.STRING.VARCHAR(40),
      sqlite: SQLITE.STRING.TEXT,
    },
    pgChanged: {
      pg: PG.STRING.CITEXT,
      mysql: MYSQL.STRING.VARCHAR(40),
      sqlite: SQLITE.STRING.TEXT,
    },
    mysqlChanged: {
      pg: PG.STRING.VARCHAR(40),
      mysql: MYSQL.STRING.LONGTEXT,
      sqlite: SQLITE.STRING.TEXT,
    },
  } as const;

  const alteredColumns = async (
    dialect: Dialect,
    from: keyof typeof versions,
    to: keyof typeof versions
  ) => {
    const { operations } = await diff(
      snapshot(noteWith(s.string(versions[from])), dialect),
      snapshot(noteWith(s.string(versions[to])), dialect)
    );
    return operations.map((operation) => operation.type);
  };

  test("changing only PostgreSQL's entry is a change on PostgreSQL alone", async () => {
    expect(await alteredColumns("pg", "first", "pgChanged")).toEqual([
      "alterColumn",
    ]);
    expect(await alteredColumns("mysql", "first", "pgChanged")).toEqual([]);
    expect(await alteredColumns("sqlite", "first", "pgChanged")).toEqual([]);
  });

  test("changing only MySQL's entry is a change on MySQL alone", async () => {
    expect(await alteredColumns("mysql", "first", "mysqlChanged")).toEqual([
      "alterColumn",
    ]);
    expect(await alteredColumns("pg", "first", "mysqlChanged")).toEqual([]);
    expect(await alteredColumns("sqlite", "first", "mysqlChanged")).toEqual([]);
  });

  test("an unchanged map is no change anywhere", async () => {
    for (const dialect of DIALECTS) {
      expect(await alteredColumns(dialect, "first", "first")).toEqual([]);
    }
  });
});
