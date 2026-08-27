import { s, TYPES } from "@schema";
import { diff } from "@src/migrations/differ";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { serializeModels } from "@src/migrations/serializer";
import type { SchemaSnapshot } from "@src/migrations/types";
import { describe, expect, test } from "vitest";

/**
 * A database built by the RETIRED scalar needs no migration.
 *
 * The scalar's name changed; its column did not. `PRE_RENAME` below is the
 * literal snapshot `s.float()` serialized on the commit before the rename — not
 * recomputed here, because a snapshot recomputed from today's code could only
 * ever agree with itself. Diffing it against `s.number()` is the whole claim: a
 * deployed schema keeps its columns, defaults, primary key and constraints.
 *
 * A migration snapshot stores PHYSICAL types, never the scalar discriminator,
 * so there is no legacy token for a snapshot reader to accept. The document
 * format does persist the discriminator, and `tests/unit/schema-json/` owns
 * that boundary.
 */

function currentSchema() {
  return {
    reading: s
      .model({
        id: s.string().id(),
        value: s.number(),
        optional: s.number().nullable(),
        scaled: s.number().default(1.5),
        renamed: s.number().map("renamed_column"),
        samples: s.number().array(),
        marked: s.number().unique(),
        narrow: s.number(TYPES.PG.FLOAT.REAL),
      })
      .map("approximate_number_physical"),
  };
}

const PRE_RENAME: Record<"pg" | "mysql" | "sqlite", SchemaSnapshot> = {
  pg: {
    tables: [
      {
        name: "approximate_number_physical",
        columns: [
          { name: "id", type: "text", nullable: false, autoIncrement: false },
          {
            name: "value",
            type: "double precision",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "optional",
            type: "double precision",
            nullable: true,
            default: "NULL",
            autoIncrement: false,
          },
          {
            name: "scaled",
            type: "double precision",
            nullable: false,
            default: "1.5",
            autoIncrement: false,
          },
          {
            name: "renamed_column",
            type: "double precision",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "samples",
            type: "double precision[]",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "marked",
            type: "double precision",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "narrow",
            type: "real",
            nullable: false,
            autoIncrement: false,
          },
        ],
        primaryKey: {
          columns: ["id"],
          name: "approximate_number_physical_pkey",
        },
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [
          {
            name: "approximate_number_physical_marked_key",
            columns: ["marked"],
          },
        ],
      },
    ],
  },
  mysql: {
    tables: [
      {
        name: "approximate_number_physical",
        columns: [
          {
            name: "id",
            type: "VARCHAR(191)",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "value",
            type: "DOUBLE",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "optional",
            type: "DOUBLE",
            nullable: true,
            default: "NULL",
            autoIncrement: false,
          },
          {
            name: "scaled",
            type: "DOUBLE",
            nullable: false,
            default: "1.5",
            autoIncrement: false,
          },
          {
            name: "renamed_column",
            type: "DOUBLE",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "samples",
            type: "JSON",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "marked",
            type: "DOUBLE",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "narrow",
            type: "DOUBLE",
            nullable: false,
            autoIncrement: false,
          },
        ],
        primaryKey: {
          columns: ["id"],
          name: "approximate_number_physical_pkey",
        },
        indexes: [
          {
            name: "approximate_number_physical_marked_key",
            columns: ["marked"],
            unique: true,
          },
        ],
        foreignKeys: [],
        uniqueConstraints: [],
      },
    ],
  },
  sqlite: {
    tables: [
      {
        name: "approximate_number_physical",
        columns: [
          { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
          {
            name: "value",
            type: "REAL",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "optional",
            type: "REAL",
            nullable: true,
            default: "NULL",
            autoIncrement: false,
          },
          {
            name: "scaled",
            type: "REAL",
            nullable: false,
            default: "1.5",
            autoIncrement: false,
          },
          {
            name: "renamed_column",
            type: "REAL",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "samples",
            type: "JSON",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "marked",
            type: "REAL",
            nullable: false,
            autoIncrement: false,
          },
          {
            name: "narrow",
            type: "REAL",
            nullable: false,
            autoIncrement: false,
          },
        ],
        primaryKey: {
          columns: ["id"],
          name: "approximate_number_physical_pkey",
        },
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [
          {
            name: "approximate_number_physical_marked_key",
            columns: ["marked"],
          },
        ],
      },
    ],
  },
};

const DIALECTS = [
  ["pg", postgresMigrationDriver, PRE_RENAME.pg],
  ["mysql", mysqlMigrationDriver, PRE_RENAME.mysql],
  ["sqlite", sqlite3MigrationDriver, PRE_RENAME.sqlite],
] as const;

describe("approximate-number physical continuity", () => {
  test.each(
    DIALECTS
  )("%s: a pre-rename database needs no migration", async (_name, driver, before) => {
    const desired = serializeModels(currentSchema(), {
      migrationDriver: driver,
    });
    const result = await diff(before, desired);

    expect(result.operations).toEqual([]);
    expect(result.ambiguousChanges).toEqual([]);
  });
});
