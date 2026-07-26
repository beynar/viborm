import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { BulkCountOperation } from "../../src/query-engine-v2/BulkCountOperation";
import { CreateManyOperation } from "../../src/query-engine-v2/CreateManyOperation";
import { CreateOperation } from "../../src/query-engine-v2/CreateOperation";
import { DeleteOperation } from "../../src/query-engine-v2/DeleteOperation";
import { ManyAndReturnOperation } from "../../src/query-engine-v2/ManyAndReturnOperation";
import type { ExecutableOperation } from "../../src/query-engine-v2/OperationExecutor";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { ReadOperation } from "../../src/query-engine-v2/ReadOperation";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { UpsertOperation } from "../../src/query-engine-v2/UpsertOperation";

/**
 * The V2-backed client proxy (PLAN P2a instrument 1, extended in P4). It wraps a
 * real V1 client and routes each migrated operation **per tree**: if a V2
 * operation constructs for the whole payload (its validator accepts it), V2
 * executes that tree; otherwise the real V1 client path runs. One client call
 * never mixes engines — routing is decided once, before any I/O, on the whole
 * payload. A genuine construction error (a `ValidationError`, the own-write
 * preflight rejection, the ATOM §7 `requiresAtomicResolution` refusal) is V1's
 * error too and is allowed to propagate; only an {@link UnsupportedOperationError}
 * means "hand this whole tree to V1".
 *
 * The `routes` spy records which engine served each call so a test can prove V2
 * actually executed when the oracle claims parity (not a silent V1 fallback).
 */
export interface RouteRecord {
  readonly model: string;
  readonly operation: string;
  readonly engine: "v1" | "v2";
}

export interface V2RoutedClient {
  readonly client: Record<string, ModelApi>;
  readonly routes: RouteRecord[];
}

type ModelApi = Record<string, (args: Record<string, unknown>) => unknown>;

const READ_OPERATIONS: ReadonlySet<string> = new Set([
  "findMany",
  "findUnique",
  "findFirst",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);

/**
 * Construct the V2 operation for a routed operation name, or return `undefined`
 * if V2 does not own it (the proxy then delegates to V1). Reads dispatch to one
 * {@link ReadOperation}; the write stragglers to their operation classes.
 */
function constructOperation(
  engine: QueryEngine,
  model: Model<any>,
  operation: string,
  args: Record<string, unknown>
): ExecutableOperation | undefined {
  if (READ_OPERATIONS.has(operation)) {
    return new ReadOperation(engine, model, operation, args);
  }
  switch (operation) {
    case "create":
      return new CreateOperation(engine, model, args);
    case "update":
      return new UpdateOperation(engine, model, args);
    case "delete":
      return new DeleteOperation(engine, model, args);
    case "upsert":
      return new UpsertOperation(engine, model, args);
    // Implicit returning (mirrors src/query-engine-v2/routing.ts): `select` on a
    // bulk write — never a second operation name — chooses the row-returning arm.
    case "createMany":
      return args.select === undefined
        ? new CreateManyOperation(engine, model, args)
        : new ManyAndReturnOperation(
            engine,
            model,
            "createManyAndReturn",
            args
          );
    case "updateMany":
      return args.select === undefined
        ? new BulkCountOperation(engine, model, operation, args)
        : new ManyAndReturnOperation(
            engine,
            model,
            "updateManyAndReturn",
            args
          );
    case "deleteMany":
      return new BulkCountOperation(engine, model, operation, args);
    default:
      return undefined;
  }
}

const ROUTED_OPERATIONS: ReadonlySet<string> = new Set([
  ...READ_OPERATIONS,
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "updateMany",
  "deleteMany",
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
    operation: string,
    args: Record<string, unknown>
  ): unknown => {
    let operationInstance: ExecutableOperation | undefined;
    try {
      operationInstance = constructOperation(engine, model, operation, args);
    } catch (error) {
      if (error instanceof UnsupportedOperationError) {
        routes.push({ model: modelName, operation, engine: "v1" });
        return client[modelName]![operation]!(args);
      }
      // A non-Unsupported construction error is V2 REJECTING a payload it owns
      // (a `ValidationError`, the own-write preflight, a required-FK disconnect
      // rejected before any I/O, the ATOM §7 refusal) — V1 rejects it too. Record
      // it as a V2 route so the oracle sees V2 handled the tree, then propagate.
      routes.push({ model: modelName, operation, engine: "v2" });
      throw error;
    }
    if (!operationInstance) {
      routes.push({ model: modelName, operation, engine: "v1" });
      return client[modelName]![operation]!(args);
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
            route(modelName, model, property, args);
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  return { client: proxied, routes };
}
