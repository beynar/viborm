import { utf8Bytes } from "@src/migrations/identity";
import type { ColumnDef, SchemaSnapshot } from "@src/migrations/types";
import { derivedMigrationName } from "@src/migrations/utils";
import {
  encodeEstateDescriptor,
  encodeSqlBlob,
} from "@src/migrations/v1-parse";
import { encodeSnapshot } from "@src/migrations/v1-parse-snapshot";
import { describe, expect, test } from "vitest";

/**
 * Migration V1 identities as 1.1.0 computed them, with `node:crypto`.
 *
 * Every published estate is content-addressed: its file names, state ids and
 * the marker's path hash are these digests. Since the hash became the in-house
 * synchronous SHA-256 (so `viborm/migrations` loads on an edge runtime), these
 * literals — produced by the `node:crypto` build — are the proof that an estate
 * written by 1.1.0 still authenticates byte for byte.
 */

const column = (
  name: string,
  type: string,
  nullable = false,
  extra: Partial<ColumnDef> = {}
): ColumnDef => ({ name, type, nullable, ...extra });

const SNAPSHOT: SchemaSnapshot = {
  tables: [
    {
      name: "owner",
      columns: [column("id", "TEXT"), column("email", "TEXT")],
      primaryKey: { name: "owner_pkey", columns: ["id"] },
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [{ name: "owner_email_key", columns: ["email"] }],
    },
    {
      name: "item",
      columns: [
        column("id", "TEXT"),
        column("sku", "TEXT"),
        column("name", "TEXT"),
        column("description", "TEXT", true),
        column("price", "numeric(10,2)"),
        column("qty", "integer", false, { default: "0" }),
        column("weight_grams", "integer", true),
        column("status", "status", false, { default: "'draft'" }),
        column("featured", "boolean", false, { default: "false" }),
        column("meta", "jsonb", true),
        column("published_at", "timestamp(3)", true),
        column("created_at", "timestamp(3)", false, { default: "now()" }),
        column("updated_at", "timestamp(3)"),
        column("owner_id", "TEXT"),
        column("label_é", "TEXT", true),
      ],
      primaryKey: { name: "item_pkey", columns: ["id"] },
      indexes: [
        { name: "item_name_qty_idx", columns: ["name", "qty"], unique: false },
      ],
      foreignKeys: [
        {
          name: "item_owner_id_fkey",
          columns: ["owner_id"],
          referencedTable: "owner",
          referencedColumns: ["id"],
          onDelete: "cascade",
        },
      ],
      uniqueConstraints: [{ name: "item_sku_key", columns: ["sku"] }],
    },
  ],
  enums: [{ name: "status", values: ["draft", "live", "archived"] }],
};

/** 10,000 rows of SQL, 846,669 UTF-8 bytes: thousands of blocks, multi-byte text. */
const SQL = Array.from(
  { length: 10_000 },
  (_, row) =>
    `INSERT INTO "item" ("id", "sku", "name") VALUES ('${row}', 'sku-${row}', 'nom-é-${row}');`
).join("\n");

describe("migration v1 identity golden vectors", () => {
  test("estate descriptors hash as 1.1.0 hashed them", () => {
    expect(encodeEstateDescriptor({ dialect: "sqlite" }).estateHash).toBe(
      "2a12938d9cbc69f82382f5721ff2cc387b1a077c77df5a5ab0e2bcc6199a1b4d"
    );
    expect(
      encodeEstateDescriptor({ dialect: "postgresql", namespace: "public" })
        .estateHash
    ).toBe("9bad5a39e8246627b9e9af1f82bf35f4a9572786e25caae7fc30be8ffb8948f7");
  });

  test("a fifteen-column snapshot hashes as 1.1.0 hashed it", () => {
    const encoded = encodeSnapshot(SNAPSHOT);
    expect(encoded.bytes.length).toBe(1578);
    expect(encoded.snapshotHash).toBe(
      "4ef77d6a092c844f21d095703119137ae269ccc2c264cf36994156d405dad1b7"
    );
  });

  test("a 10,000-row SQL blob hashes as 1.1.0 hashed it", () => {
    const bytes = utf8Bytes(SQL);
    expect(bytes.length).toBe(846_669);
    expect(encodeSqlBlob(bytes)).toBe(
      "97fa0b5d26e865651fe092b5d209e1c971f770114d80eb76720a6d03ff1f92d6"
    );
  });

  test("a derived identifier keeps its UTF-8 byte cut and digest suffix", () => {
    // 50 two-byte characters: the 54-byte prefix cut lands between
    // characters, and the suffix is the name's own digest.
    expect(derivedMigrationName(`${"é".repeat(50)}_left_key`)).toBe(
      `${"é".repeat(27)}_9ceaab7e`
    );
  });
});
