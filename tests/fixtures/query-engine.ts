/**
 * A query engine for a contract test that builds no client.
 *
 * PRODUCTION builds its one engine in `VibORM`'s constructor, over the route
 * that constructor composes from the client's one resolved index and schema
 * registry. A contract test that builds no client is its own composition root:
 * {@link createModelRegistry} resolves its schema once, {@link TestQueryEngine}
 * provisions the route over that pair by identity — nothing is resolved,
 * hydrated or registered a second time — and {@link TestQueryEngine.build}
 * asks the prepared operation for the ONE statement it compiles to, refusing
 * the `undefined` a verb that compiles to no single statement answers.
 */

import type { AnyDriver } from "@drivers";
import type { ResolvedExtensionChain } from "@extensions/chain";
import type { TransactionWriteOutcomes } from "@extensions/query";
import { QueryEngine } from "@query-engine/query-engine";
import {
  type ClientOperationRoute,
  createCandidateRoute,
} from "@query-engine/raptor3/route/client-route";
import { type Operation, QueryEngineError } from "@query-engine/types";
import type { Model } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import type { Sql } from "@sql";
import type { SchemaRegistryLookup } from "@validation";

/** The two resolved views a route is composed over. */
export interface TestModelRegistry {
  readonly schemas: Pick<SchemaRegistryLookup, "getModelSchemas" | "validate">;
  readonly relations: ResolvedRelationIndex;
}

/** Resolve a standalone test schema once, for its own lifecycle. */
export function createModelRegistry(
  models: Record<string, Model<any>>,
  schemas: TestModelRegistry["schemas"],
  relations: ResolvedRelationIndex = resolveSchemaOrThrow(models)
): TestModelRegistry {
  return { schemas, relations };
}

/**
 * The route `VibORM`'s constructor composes, over a test registry. The model
 * map is rebuilt from the index's keys, which enumerate every model of the
 * schema, under the name the route and `PendingOperation` look a model up by.
 */
function provisionedRoute(
  driver: AnyDriver,
  registry: TestModelRegistry
): ClientOperationRoute {
  const schema: Record<string, Model<any>> = {};
  for (const model of registry.relations.keys()) {
    schema[model["~"].names.ts ?? "unknown"] = model;
  }
  return createCandidateRoute(schema, driver, {
    index: registry.relations,
    registry: registry.schemas,
  });
}

export class TestQueryEngine extends QueryEngine {
  constructor(
    driver: AnyDriver,
    registry: TestModelRegistry,
    clientId?: symbol,
    scopeId?: symbol,
    extensionChain?: ResolvedExtensionChain,
    transactionWriteOutcomes?: TransactionWriteOutcomes,
    route: ClientOperationRoute = provisionedRoute(driver, registry)
  ) {
    super(
      driver,
      route,
      clientId,
      scopeId,
      extensionChain,
      transactionWriteOutcomes
    );
  }

  /** The one statement an operation compiles to, or the refusal. */
  build(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): Sql {
    const statement = this.prepare<unknown>(
      model,
      operation,
      args
    ).buildStatement();
    if (statement) return statement;
    throw new QueryEngineError(
      `Operation '${operation}' does not compile to one SQL statement. Execute the operation instead.`
    );
  }
}
