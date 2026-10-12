import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { unsupportedVector } from "@errors";
import { defineImmutableDriverFact } from "./driver-options";

/**
 * Install a PostgreSQL driver's adapter: `pgvector` alone decides the vector
 * capability, `postgis` the spatial one.
 */
export function installPostgresAdapter(
  driver: object,
  namespace: string | undefined,
  options: { readonly pgvector?: boolean; readonly postgis?: boolean }
): void {
  const adapter = new PostgresAdapter(namespace, options.postgis === true);
  adapter.capabilities.supportsVector = options.pgvector === true;
  if (!options.pgvector) adapter.vector = unsupportedVector;
  defineImmutableDriverFact(driver, "adapter", adapter);
}
