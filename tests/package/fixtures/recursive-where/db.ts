// The client as a consumer builds it: the plain client, or the same client
// extended with instrumentation when logging is asked for. The exported type
// is the union of both, as `ReturnType` of such a factory is.

import type { OperationPayload, OperationResult, Schema } from "viborm/client";
import {
  type InstrumentationConfig,
  instrumentation,
} from "viborm/instrumentation";
import { createClient } from "viborm/pg";
import type { ModelCoreInput } from "viborm/validation";
import { schema } from "./schema";

export interface DatabaseParams {
  databaseUrl: string;
  namespace?: string;
  logging?: InstrumentationConfig["logging"];
}

export function createDatabase({
  databaseUrl,
  namespace,
  logging,
}: DatabaseParams) {
  const database = createClient({
    schema,
    databaseUrl,
    ...(namespace === undefined ? {} : { namespace }),
  });
  return logging === undefined
    ? database
    : database.$extends(instrumentation({ logging }));
}

export type Database = ReturnType<typeof createDatabase>;

export type InferDatabase<S extends Schema> = {
  [K in keyof S]: {
    Row: OperationResult<"findMany", S[K], Record<never, never>>[number];
    Create: ModelCoreInput<S[K], "create">;
    Update: ModelCoreInput<S[K], "update">;
    Where: ModelCoreInput<S[K], "where">;
    FindMany: OperationPayload<"findMany", S[K]>;
  };
};

export type Tables = InferDatabase<typeof schema>;
