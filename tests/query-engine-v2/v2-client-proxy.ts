import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { DeleteOperation } from "../../src/query-engine-v2/DeleteOperation";
import type { ExecutableOperation } from "../../src/query-engine-v2/OperationExecutor";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";

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
  readonly operation: "update" | "delete";
  readonly engine: "v1" | "v2";
}

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

const CONSTRUCTORS: Record<"update" | "delete", ConstructOperation> = {
  update: (engine, model, args) => new UpdateOperation(engine, model, args),
  delete: (engine, model, args) => new DeleteOperation(engine, model, args),
};

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
    operation: "update" | "delete",
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
        if (property === "update" || property === "delete") {
          return (args: Record<string, unknown>) =>
            route(modelName, model, property, args);
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  return { client: proxied, routes };
}
