/**
 * Centralized Schema Builder
 *
 * Builds all validation schemas (scalars, relations, models) from a central registry.
 * Uses lazy evaluation (thunks) to handle circular dependencies between models.
 *
 * Key insight: Using Model object as Map key allows direct lookup via relation.getter()
 */

import { ValidationError } from "@errors";
import type { AnyModel, Model } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { getModelSchemas, type ModelSchemas } from "./model";
import { getRelationsSchemas } from "./relations";
import { getPolymorphicRelationsSchemas } from "./relations/polymorphic";
import type { GetTargetSchemas } from "./relations/helpers";
import { getScalarsSchemas } from "./scalars";
import type { SchemaRegistryLookup, SchemaRegistryOperation } from "./types";
import { isString } from "./value-guards";

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
          if (!(isString(prop) && prop in schema && schema[prop])) {
            const property = String(prop);
            throw new ValidationError({ kind: "registry", property }, [
              { path: property, message: `${property} does not exist` },
            ]);
          }
          return this.getModelSchemas(schema[prop]);
        },
      }
    ) as {
      [K in keyof S]: ModelSchemas<S[K]>;
    };
  }

  private readonly createSchemasGetter = <S extends RelationState>(
    state: S
  ) => {
    return () => {
      const targetModel = state.getter() as AnyModel;
      return this.getModelSchemas(
        targetModel
      ) as unknown as GetTargetSchemas<S>;
    };
  };

  private readonly buildModelSchemas = (
    model: AnyModel
  ): ModelSchemas<AnyModel> => {
    const scalars = getScalarsSchemas(model);
    const relations = getRelationsSchemas(model, this.createSchemasGetter);
    const polymorphic = getPolymorphicRelationsSchemas(
      model,
      this.getModelSchemas
    );
    const { args, core } = getModelSchemas(model, {
      scalars,
      relations,
      polymorphic,
    });
    return {
      scalars,
      relations,
      polymorphic,
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
    payload: unknown
  ) => {
    const model = this.schema[modelName];
    if (!model) {
      throw new ValidationError(
        { kind: "operation", operation, model: modelName },
        [{ path: modelName, message: `${modelName} does not exist` }],
        { meta: { model: modelName } }
      );
    }
    const schemas = this.getModelSchemas(model);
    try {
      const result = schemas.args[operation]["~standard"].validate(payload);
      if (result.issues) {
        const issues = result.issues.map((issue) => ({
          path: issue.path?.map((part) => part).join(".") ?? "",
          message: issue.message,
        }));
        throw new ValidationError(operation, issues, {
          meta: { model: modelName },
        });
      }
      return result.value;
    } catch (cause) {
      if (cause instanceof ValidationError) throw cause;
      throw new ValidationError(
        { kind: "operation", operation, model: modelName },
        [
          {
            path: "",
            message: "The external schema validator threw unexpectedly",
          },
        ],
        {
          ...(cause instanceof Error ? { cause } : {}),
          meta: { model: modelName },
        }
      );
    }
  };
}

export const createSchemaRegistry = <S extends Record<string, Model<any>>>(
  schema: S
): SchemaRegistry<S> => {
  return new SchemaRegistry(schema);
};
