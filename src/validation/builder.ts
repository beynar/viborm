/**
 * Centralized Schema Builder
 *
 * Builds all validation schemas (fields, relations, models) from a central registry.
 * Uses lazy evaluation (thunks) to handle circular dependencies between models.
 *
 * Key insight: Using Model object as Map key allows direct lookup via relation.getter()
 */

import { ValidationError } from "@errors";
import type { AnyModel, Model } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { getRelationsSchemas } from "./relations";
import type { GetTargetSchemas } from "./relations/helpers";
import { getScalarsSchemas } from "./scalars";
import { getModelSchemas, type ModelSchemas } from "./model";
import type { SchemaRegistryLookup, SchemaRegistryOperation } from "./types";

// =============================================================================
// SCHEMA REGISTRY
// =============================================================================

export class SchemaRegistry<S extends Record<string, AnyModel>>
  implements SchemaRegistryLookup
{
  private readonly cache = new Map<AnyModel, ModelSchemas<AnyModel>>();
  private readonly schema: S;
  readonly proxy: {
    [K in keyof S]: ModelSchemas<S[K]>;
  };

  constructor(schema: S) {
    this.schema = schema;

    this.proxy = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== "string" || !(prop in schema) || !schema[prop]) {
            throw new Error(`${String(prop)} does not exist`);
          }
          return this.getModelSchemas(schema[prop]);
        },
      },
    ) as {
      [K in keyof S]: ModelSchemas<S[K]>;
    };
  }

  private createSchemasGetter = <S extends RelationState>(state: S) => {
    return () => {
      const targetModel = state.getter() as AnyModel;
      return this.getModelSchemas(
        targetModel,
      ) as unknown as GetTargetSchemas<S>;
    };
  };

  private buildModelSchemas = (model: AnyModel): ModelSchemas<AnyModel> => {
    const scalars = getScalarsSchemas(model);
    const relations = getRelationsSchemas(model, this.createSchemasGetter);
    const { args, core } = getModelSchemas(model, { scalars, relations });
    return {
      scalars,
      relations,
      args,
      core,
    } as unknown as ModelSchemas<AnyModel>;
  };

  getModelSchemas = (model: AnyModel): ModelSchemas<AnyModel> => {
    let schemas = this.cache.get(model);
    if (!schemas) {
      schemas = this.buildModelSchemas(model);
      this.cache.set(model, schemas);
    }
    return schemas as ModelSchemas<AnyModel>;
  };

  validate = (
    modelName: string,
    operation: SchemaRegistryOperation,
    payload: unknown,
  ) => {
    const model = this.schema[modelName];
    if (!model) {
      throw new Error(`${modelName} does not exist`);
    }
    const schemas = this.getModelSchemas(model);
    const result = schemas.args[operation]["~standard"].validate(payload);
    if (result instanceof Promise) {
      throw new ValidationError(operation, [], {
        meta: { model: modelName, hint: "Async validation is not supported" },
      });
    }
    if (result.issues) {
      const issues = result.issues.map((issue) => ({
        path: issue.path?.map((p) => p).join(".") ?? "",
        message: issue.message,
      }));
      throw new ValidationError(operation, issues, { meta: { model: modelName } });
    }
    return result.value;
  };
}

export const createSchemaRegistry = <S extends Record<string, Model<any>>>(
  schema: S,
): SchemaRegistry<S> => {
  return new SchemaRegistry(schema);
};
