/**
 * What PostgreSQL's catalog reads report about a NULLS NOT DISTINCT unique
 * index on a managed table, on a live server (PostgreSQL 15+): introspection
 * refuses it, the one-statement digest abstains, and on a server without
 * `pg_index.indnullsnotdistinct` (before PostgreSQL 15, simulated by answering
 * the column probe) the same introspection builds and runs without naming the
 * column. Neither read may reach the column through a whole-row reference,
 * which PlanetScale's Neki refuses.
 */

import type { AnyDriver } from "@drivers/driver";
import { controlTableNames, DEFAULT_CONTROL_BASE } from "@migrations/control";
import { postgresCatalogDigest } from "@migrations/drivers/postgres/catalog-digest";
import { NULLS_NOT_DISTINCT_QUERY } from "@migrations/drivers/postgres/introspect";
import type { MigrationClient } from "@migrations/push/planner";
import { getPushMigrationDriver } from "@migrations/push/planner";
import { introspectManaged } from "@migrations/push-plan";
import { s } from "@schema";

export const NULLS_NOT_DISTINCT_INDEX = "accounts_email_nnd";

export const nekiCatalogSchema = () => ({
  account: s
    .model({ id: s.string().id(), email: s.string().nullable() })
    .map("accounts"),
});

/** `CREATE UNIQUE INDEX … NULLS NOT DISTINCT` on the pushed table. */
export const nullsNotDistinctIndexSql = (namespace: string): string =>
  `CREATE UNIQUE INDEX "${NULLS_NOT_DISTINCT_INDEX}" ON "${namespace}"."accounts" ("email") NULLS NOT DISTINCT`;

/** A producer whose server answers that `pg_index` has no such column. */
function beforePostgres15(producer: AnyDriver): AnyDriver {
  const legacy: AnyDriver = Object.create(producer);
  Object.defineProperty(legacy, "_executeRaw", {
    value: (sql: string, params?: unknown[]) =>
      sql === NULLS_NOT_DISTINCT_QUERY
        ? Promise.resolve({ rows: [{ present: false }], rowCount: 1 })
        : producer._executeRaw(sql, params),
  });
  return legacy;
}

/** The three readings, once the index exists. */
export async function readNullsNotDistinctIndex(
  orm: MigrationClient & { readonly $driver: AnyDriver }
): Promise<{
  readonly refusal: unknown;
  readonly digest: string | undefined;
  readonly legacyIndexes: readonly string[];
}> {
  const driver = getPushMigrationDriver(orm);
  const refusal = await introspectManaged(orm.$driver, driver).then(
    () => undefined,
    (error: unknown) => error
  );
  const digest = await postgresCatalogDigest(
    orm.$driver,
    driver,
    controlTableNames(DEFAULT_CONTROL_BASE)
  );
  const legacy = await introspectManaged(beforePostgres15(orm.$driver), driver);
  return {
    refusal,
    digest,
    legacyIndexes: legacy.tables.flatMap((table) =>
      table.indexes.map((index) => index.name)
    ),
  };
}
