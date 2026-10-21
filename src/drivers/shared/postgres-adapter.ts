import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { ClientInitializationError, unsupportedVector } from "@errors";
import { defineImmutableDriverFact } from "./driver-options";

/**
 * Install a PostgreSQL driver's adapter: `pgvector` alone decides the vector
 * capability, `postgis` the spatial one, `sharedRelationBodies` whether a
 * statement states each relation body it repeats once (the default: the
 * answers are the same and the statement smaller; `false` keeps every body
 * inline, as 1.2.4 spelled it), `relationsPerStatement` the relations a
 * statement may reference before it trades plans for fewer (absent:
 * unbounded until the server says otherwise, `relation-bound.ts`; PlanetScale
 * Neki needs 256).
 */
export function installPostgresAdapter(
  driver: object,
  namespace: string | undefined,
  options: {
    readonly pgvector?: boolean;
    readonly postgis?: boolean;
    readonly sharedRelationBodies?: boolean;
    readonly relationsPerStatement?: number;
  }
): void {
  const adapter = new PostgresAdapter(namespace, options.postgis === true);
  adapter.capabilities.supportsVector = options.pgvector === true;
  const bound = options.relationsPerStatement;
  // A bound of 0, a fraction or NaN would escalate every statement or none.
  if (bound !== undefined && !(Number.isSafeInteger(bound) && bound > 0))
    throw new ClientInitializationError(
      `The "relationsPerStatement" option must be a positive integer (256 for PlanetScale Neki); received ${typeof bound === "number" ? bound : `type "${typeof bound}"`}.`
    );
  if (options.sharedRelationBodies !== false) {
    adapter.capabilities.sharesRelationBodies = true;
    adapter.capabilities.relationsPerStatement = bound;
  }
  if (!options.pgvector) adapter.vector = unsupportedVector;
  defineImmutableDriverFact(driver, "adapter", adapter);
}
