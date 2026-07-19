import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { CreateManyOperation } from "../../src/query-engine-v2/CreateManyOperation";
import { DeleteOperation } from "../../src/query-engine-v2/DeleteOperation";
import type { ExecutableOperation } from "../../src/query-engine-v2/OperationExecutor";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { UpsertOperation } from "../../src/query-engine-v2/UpsertOperation";

/**
 * The V2-backed client proxy (PLAN P2a instrument 1). It wraps a real V1 client
 * and routes each `update`/`delete` **per tree**: if a V2 operation constructs
 * for the whole payload (its validator accepts it), V2 executes that tree;
 * otherwise the real V1 client path runs. One client call never mixes engines —
 * routing is decided once, before any I/O, on the whole payload. A genuine
 * construction error (a `ValidationError`, the own-write preflight rejection) is
 * V1's error too and is allowed to propagate; only an
 * {@link UnsupportedOperationError} means "hand this whole tree to V1".
 *
 * The `routes` spy records which engine served each call so a test can prove V2
 * actually executed when the oracle claims parity (not a silent V1 fallback).
 */
export interface RouteRecord {
  readonly model: string;
  readonly operation: RoutedOperation;
  readonly engine: "v1" | "v2";
}

type RoutedOperation = "createMany" | "delete" | "update" | "upsert";

export interface V2RoutedClient {
  readonly client: Record<string, ModelApi>;
  readonly routes: RouteRecord[];
}

type ModelApi = Record<string, (args: Record<string, unknown>) => unknown>;

type ConstructOperation = (
  engine: QueryEngine,
  model: Model<any>,
  args: Record<string, unknown>
) => ExecutableOperation;

const CONSTRUCTORS: Record<RoutedOperation, ConstructOperation> = {
  update: (engine, model, args) => new UpdateOperation(engine, model, args),
  delete: (engine, model, args) => new DeleteOperation(engine, model, args),
  upsert: (engine, model, args) => new UpsertOperation(engine, model, args),
  createMany: (engine, model, args) =>
    new CreateManyOperation(engine, model, args),
};

const ROUTED_OPERATIONS: ReadonlySet<string> = new Set([
  "update",
  "delete",
  "upsert",
  "createMany",
]);

export function createV2RoutedClient(options: {
  schema: Record<string, Model<any>>;
  /** A V1 client bound to the same database (V1 fallback + reads). */
  client: Record<string, ModelApi>;
  /** A driver bound to the same database as `client`, for the V2 arm. */
  driver: AnyDriver;
}): V2RoutedClient {
  const { schema, client, driver } = options;
  const schemas = createSchemaRegistry(schema);
  const engine = new QueryEngine(driver, createModelRegistry(schema, schemas));
  const executor = new OperationExecutor(engine);
  const routes: RouteRecord[] = [];

  const route = (
    modelName: string,
    model: Model<any>,
    operation: RoutedOperation,
    args: Record<string, unknown>
  ): unknown => {
    let operationInstance: ExecutableOperation;
    try {
      operationInstance = CONSTRUCTORS[operation](engine, model, args);
    } catch (error) {
      if (error instanceof UnsupportedOperationError) {
        routes.push({ model: modelName, operation, engine: "v1" });
        return client[modelName]![operation]!(args);
      }
      // A non-Unsupported construction error is V2 REJECTING a payload it owns
      // (a `ValidationError`, the own-write preflight, a required-FK disconnect
      // rejected before any I/O) — V1 rejects it too. Record it as a V2 route so
      // the oracle sees V2 handled the tree, then propagate the genuine error.
      routes.push({ model: modelName, operation, engine: "v2" });
      throw error;
    }
    routes.push({ model: modelName, operation, engine: "v2" });
    const context = createOperationExecutionContext(
      modelName,
      operation,
      engine.instrumentation
    );
    return executor.execute(operationInstance, context);
  };

  const proxied: Record<string, ModelApi> = {};
  for (const [modelName, model] of Object.entries(schema)) {
    const real = client[modelName]!;
    proxied[modelName] = new Proxy(real, {
      get(target, property, receiver) {
        if (typeof property === "string" && ROUTED_OPERATIONS.has(property)) {
          return (args: Record<string, unknown>) =>
            route(modelName, model, property as RoutedOperation, args);
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  return { client: proxied, routes };
}
