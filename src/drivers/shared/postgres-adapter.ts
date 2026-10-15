import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { unsupportedVector } from "@errors";
import { defineImmutableDriverFact } from "./driver-options";

/**
 * Install a PostgreSQL driver's adapter: `pgvector` alone decides the vector
 * capability, `postgis` the spatial one, `sharedRelationBodies` whether a
 * statement states each relation body it repeats once.
 */
export function installPostgresAdapter(
  driver: object,
  namespace: string | undefined,
  options: {
    readonly pgvector?: boolean;
    readonly postgis?: boolean;
    readonly sharedRelationBodies?: boolean;
  }
): void {
  const adapter = new PostgresAdapter(namespace, options.postgis === true);
  adapter.capabilities.supportsVector = options.pgvector === true;
  if (options.sharedRelationBodies === true)
    adapter.capabilities.sharesRelationBodies = true;
  if (!options.pgvector) adapter.vector = unsupportedVector;
  defineImmutableDriverFact(driver, "adapter", adapter);
}
