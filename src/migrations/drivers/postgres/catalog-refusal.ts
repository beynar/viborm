/**
 * How a refused PostgreSQL catalog read is reported. Apart from
 * introspection, so the shared control-table read (`control.ts`) brings no
 * PostgreSQL introspection into another dialect's bundle.
 */

import { MigrationError, VibORMErrorCode } from "../../../errors";
import { providerRefused } from "../../execute-dispatch";

/**
 * A catalog read the provider refused, thrown named with its SQLSTATE: a
 * server that speaks PostgreSQL but not all of its catalog SQL (PlanetScale's
 * Neki) must say which read it refused, not that the estate is wrong. The
 * server's own text stays in the cause, disclosed as the driver's diagnostics
 * allow. A transport failure is not a refusal, nor is a migration error
 * already named: the caller handles them.
 */
export function throwIfCatalogRefusal(query: string, error: unknown): void {
  // A migration outcome raised before the read was sent (the lock protocol's
  // own statements, such as the session's limits) is not the read's refusal.
  if (!providerRefused(error) || error instanceof MigrationError) return;
  const { providerCode, providerSqlState } = error.meta;
  throw new MigrationError(
    `PostgreSQL catalog query "${query}" failed with SQLSTATE ${String(providerSqlState ?? providerCode)}: ${error.message}`,
    VibORMErrorCode.MIGRATION_FAILED,
    { cause: error, meta: { providerCode, providerSqlState } }
  );
}
