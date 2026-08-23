/**
 * Centralized Schema Builder
 *
 * Builds all validation schemas (scalars, relations, models) from a central registry.
 * Uses lazy evaluation (thunks) to handle circular dependencies between models.
 *
 * Key insight: Using Model object as Map key allows direct lookup via the
 * relation's settled target (RelationInternal.settleTarget)
 */

import { ValidationError } from "@errors";
import { hydrateSchemaNames } from "@schema/hydration";
import type { AnyModel, Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import type { RelationState } from "@schema/relation/types";
import { resolveSchemaOrThrow } from "@schema/validation";
import type {
  ResolvedRelationIndex,
  ResolvedSlot,
} from "@schema/validation/relation-resolution";
import { getModelSchemas, type ModelSchemas } from "./model";
import { getRelationsSchemas } from "./relations";
import type { GetTargetSchemas } from "./relations/helpers";
import { getPolymorphicRelationsSchemas } from "./relations/polymorphic";
import { getScalarsSchemas } from "./scalars";
import type { SchemaRegistryLookup, SchemaRegistryOperation } from "./types";
import { isString } from "./value-guards";

// =============================================================================
// SCHEMA REGISTRY
// =============================================================================

class SchemaRegistry<S extends Record<string, AnyModel>>
  implements SchemaRegistryLookup
{
  private readonly cache = new Map<AnyModel, ModelSchemas<AnyModel>>();
  private readonly schema: S;
  /**
   * The one trusted topology, by identity. The operation schemas this registry
   * builds decide which mutation verbs a caller may spell and which keys a
   * nested payload owns — both are topology answers, so the registry consumes
   * the resolved index rather than re-deriving anything from declarations.
   */
  private readonly index: ResolvedRelationIndex;
  readonly proxy: {
    [K in keyof S]: ModelSchemas<S[K]>;
  };

  constructor(schema: S, index: ResolvedRelationIndex) {
    this.schema = schema;
    this.index = index;

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
    relation: AnyRelation
  ) => {
    return () => {
      // `settleTarget` is the one sanctioned getter invocation (§11.1.16b).
      const targetModel = relation["~"].settleTarget() as AnyModel;
      return this.getModelSchemas(
        targetModel
      ) as unknown as GetTargetSchemas<S>;
    };
  };

  private readonly buildModelSchemas = (
    model: AnyModel
  ): ModelSchemas<AnyModel> => {
    const scalars = getScalarsSchemas(model);
    // `createResolvedSchemaRegistry` accepts the index resolved for this exact
    // schema. Every registered model therefore has one slot map, including an
    // empty map for a model with no relations.
    const slots: ReadonlyMap<string, ResolvedSlot> = this.index.get(model)!;
    const relations = getRelationsSchemas(
      model,
      this.createSchemasGetter,
      slots
    );
    const polymorphic = getPolymorphicRelationsSchemas(
      model,
      this.getModelSchemas
    );
    const { args, core } = getModelSchemas(
      model,
      { scalars, relations, polymorphic },
      slots
    );
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

/**
 * Compose a registry over an ALREADY RESOLVED schema.
 *
 * The index is a parameter, not a side effect: client construction resolves
 * once and shares that exact instance with the registry, the omit rewriting and
 * the query engine (§11.4.10). A standalone registry has no such owner, so it
 * resolves once for its own lifecycle — which is also the mandatory definition
 * gate for this boundary (§7.3): operation schemas may not be built over a
 * schema whose topology was never proven.
 */
export const createResolvedSchemaRegistry = <
  S extends Record<string, Model<any>>,
>(
  schema: S,
  index: ResolvedRelationIndex
): SchemaRegistry<S> => {
  return new SchemaRegistry(schema, index);
};

/** Public standalone boundary: prepare and resolve its own schema. */
export const createSchemaRegistry = <S extends Record<string, Model<any>>>(
  schema: S
): SchemaRegistry<S> => {
  hydrateSchemaNames(schema);
  return createResolvedSchemaRegistry(schema, resolveSchemaOrThrow(schema));
};
