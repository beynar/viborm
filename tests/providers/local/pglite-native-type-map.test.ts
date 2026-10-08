/**
 * PGlite — one schema, a native type per dialect (#45).
 *
 * One shared PGlite per file with a private schema (`usePGliteSchemaFamily`).
 * PostgreSQL selects the maps' `pg` entries — a `bytea` uuid key, a
 * `varchar(40)` handle, `smallint` and `real` — and its automatic column where
 * a map has no `pg` entry (the DateTime and the list). The cells are shared with the SQLite3, PostgreSQL and
 * MySQL suites: `tests/fixtures/native-type-map.ts`.
 */

import { createClient } from "@client/client";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import {
  nativeTypeMapCells,
  nativeTypeMapSchema,
} from "@tests/fixtures/native-type-map";
import { describe } from "vitest";

describe("PGlite native type per dialect", () => {
  const family = usePGliteSchemaFamily(nativeTypeMapSchema);
  nativeTypeMapCells({
    dialect: "pg",
    namespace: () => family().namespace,
    client: () => family().client,
    clientFor: (schema) => createClient({ schema, driver: family().driver }),
    reset: () => family().reset(),
    expectedCatalog: {
      owners: {
        id: "bytea",
        handle: "character varying(40)",
        score: "smallint",
        ratio: "real",
        seenAt: "timestamp(3) with time zone",
        tags: "text[]",
      },
      pets: { id: "text", name: "text", ownerId: "bytea" },
    },
    raw: { id: "bytes", seenAt: "provider" },
  });
});
