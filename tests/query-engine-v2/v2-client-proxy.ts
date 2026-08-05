import type { AnyDriver } from "@drivers";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import type { ExecutableOperation } from "../../src/query-engine/write-engine/OperationExecutor";
import { OperationExecutor } from "../../src/query-engine/write-engine/OperationExecutor";
import {
  constructRoutedOperation,
  ROUTED_OPERATIONS,
} from "../../src/query-engine/write-engine/routing";
import { UnsupportedOperationError } from "../../src/query-engine/write-engine/shared";

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
 *
 * CONSTRUCTION IS PRODUCTION'S, not a copy of it. This file used to carry its own
 * `constructOperation` under a comment claiming it "mirrors routing.ts", and it
 * had stopped: the W5 `omit` wave taught production that `omit` is the other
 * spelling of the row-returning discriminant (`returnsRows` — `select` OR
 * `omit`), while the harness still discriminated on `args.select === undefined`
 * alone. An `omit`-only bulk write therefore answered `[{ … }]` in production and
 * `{ count }` here, with the route spy still reporting `engine: "v2"` — an oracle
 * that would have certified the wrong arm. The duplicate also predated
 * `assertRoutedAtomicResolution`, so the harness could not have reproduced the
 * batch-only refusal either. Calling {@link constructRoutedOperation} makes both
 * drifts unrepresentable: the only thing this file still owns is the FALLBACK,
 * which is the instrument's whole reason to exist.
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
      operationInstance = constructRoutedOperation(
        engine,
        model,
        operation,
        args
      );
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
