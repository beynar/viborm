/**
 * Opening a query scope in a contract test.
 *
 * PRODUCTION opens every scope from the engine, which already holds the ONE
 * index the client's gate resolved (§11.4.10). A contract test that builds no
 * client is its own composition root: it prepares a schema once — hydrate, then
 * gate — and every scope it opens over that schema's models shares that index by
 * identity, exactly as a client's do.
 *
 * The model → index map exists so a call site can ask for a scope with the two
 * things it actually has in hand (an adapter and a model). It is a HARNESS
 * convenience, not a topology store: nothing reads it to decide an edge, and the
 * value it hands back is the gate's own published index.
 */

import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver } from "@drivers";
import { createQueryScope } from "@query-engine/context";
import { ResultParser } from "@query-engine/result/ResultParser";
import type { QueryScope } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import type { AnyModel } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { resolveSchemaOrThrow } from "@schema/validation/validator";

const indexByModel = new WeakMap<AnyModel, ResolvedRelationIndex>();

/**
 * Hydrate and GATE one test schema, remembering its index for every model.
 *
 * The STRUCTURAL gate only — the same one `createModelRegistry` runs for a
 * standalone composition. Advisory rules are a client-construction concern and a
 * scope needs none of them.
 */
export function prepareSchema(
  schema: Record<string, AnyModel>
): ResolvedRelationIndex {
  hydrateSchemaNames(schema);
  const relations = resolveSchemaOrThrow(schema);
  for (const model of Object.values(schema)) indexByModel.set(model, relations);
  return relations;
}

/** Open a root scope over a model prepared by {@link prepareSchema}. */
export function scopeFor(
  adapter: DatabaseAdapter,
  model: AnyModel
): QueryScope {
  return createQueryScope({ adapter, relations: indexFor(model) }, model);
}

/** The index of the schema one prepared model belongs to. */
export function indexFor(model: AnyModel): ResolvedRelationIndex {
  const relations = indexByModel.get(model);
  if (!relations) {
    throw new Error(
      "This model's schema was not prepared. Call prepareSchema(schema) first."
    );
  }
  return relations;
}

/** A result parser over a model prepared by {@link prepareSchema}. */
export function parserFor(
  adapter: DatabaseAdapter,
  model: AnyModel,
  driver?: AnyDriver
): ResultParser {
  return new ResultParser(
    { adapter, relations: indexFor(model) },
    model,
    driver
  );
}
