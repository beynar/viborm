/**
 * The pattern engine's compile chain for one corpus cell, shared by the M1
 * (compile) and M2 (execution) differentials: validated args → construct (C)
 * → schedule (D) → pack (E). Refusals surface as thrown errors whose name and
 * message are what the differentials compare.
 */

import type { QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import {
  constructPattern,
  type DeferredRefusal,
  type WriteOperation,
} from "@src/query-engine/pattern/construct";
import type { Program } from "@src/query-engine/pattern/fragment";
import { StepIds } from "@src/query-engine/pattern/ids";
import { pack } from "@src/query-engine/pattern/pack";
import { type Scheduled, schedule } from "@src/query-engine/pattern/schedule";
import type { PlanningKnown } from "@src/query-engine/write-engine/Part";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import type { CorpusPayload } from "@tests/pattern/corpus/payloads";
import { schemas } from "@tests/pattern/corpus/schemas";
import type { Substrate } from "@tests/pattern/harness/dump";
import { createSchemaRegistry } from "@validation";

export const WRITE_OPERATIONS = new Set<string>([
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "createManyAndReturn",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
  "deleteManyAndReturn",
]);

export function schemaOf(payload: CorpusPayload): {
  schema: Record<string, Model<any>>;
  model: Model<any>;
} {
  const schema = schemas[payload.schema] as Record<string, Model<any>>;
  return { schema, model: schema[payload.model] as Model<any> };
}

function raise(refusal: DeferredRefusal): never {
  // ponytail: name + message is what the differentials compare; the exact
  // class (and code) is the raiser's concern.
  const error = new Error(refusal.message);
  error.name = refusal.error;
  throw error;
}

/** Validate → construct → schedule. Throws construction and legality refusals. */
export function scheduleCell(
  payload: CorpusPayload,
  engine: QueryEngine,
  dialect: PlanningDialect,
  substrate: Substrate
): Scheduled {
  const { schema, model } = schemaOf(payload);
  const registry = createSchemaRegistry(schema);
  const args = parseValidated(
    Reflect.get(registry.getModelSchemas(model).args, payload.operation),
    payload.args,
    payload.operation as never,
    ""
  ) as Record<string, unknown>;
  const { pattern, deferredRefusals } = constructPattern({
    index: engine.relations,
    model,
    operation: payload.operation as WriteOperation,
    validatedArgs: args,
  });
  return schedule(
    pattern,
    {
      bindsGeneratedKey: dialect === "mysql" ? "insertId" : "returning",
      supportsTransactions: substrate === "transaction",
    },
    deferredRefusals.map((refusal) => () => raise(refusal))
  );
}

/** Pack the schedule; `known` re-packs the taken arm with match results. */
export function packCell(
  scheduled: Scheduled,
  engine: QueryEngine,
  known?: PlanningKnown
): Program {
  return pack(scheduled, engine, new StepIds(), known);
}

export function errorOf(e: unknown): { name: string; message: string } {
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "unknown", message: String(e) };
}
