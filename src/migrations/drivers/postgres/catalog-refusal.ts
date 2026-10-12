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
 * allow. A transport failure is not a refusal: the caller handles it.
 */
export function throwIfCatalogRefusal(query: string, error: unknown): void {
  if (!providerRefused(error)) return;
  const { providerCode, providerSqlState } = error.meta;
  throw new MigrationError(
    `PostgreSQL catalog query "${query}" failed with SQLSTATE ${String(providerSqlState ?? providerCode)}: ${error.message}`,
    VibORMErrorCode.MIGRATION_FAILED,
    { cause: error, meta: { providerCode, providerSqlState } }
  );
}
