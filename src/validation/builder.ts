/**
 * Centralized Schema Builder
 *
 * Builds all validation schemas (fields, relations, models) from a central registry.
 * Uses lazy evaluation (thunks) to handle circular dependencies between models.
 *
 * Key insight: Using Model object as Map key allows direct lookup via relation.getter()
 */

import { ValidationError } from "@errors";
import { s } from "@schema/index";
import type { AnyModel, Model } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { z } from "zod/v4";
import { type GetRelationsSchemas, getRelationsSchemas } from "./relations";
import type { GetTargetSchemas } from "./relations/helpers";
import { type GetScalarsSchemas, getScalarsSchemas } from "./scalars";
import type { Simplify, VibSchema } from "./types";
import { getModelSchemas } from "./model";
import { getIncludeSchema } from "./model/core";
import { StandardSchemaV1 } from "@standard-schema/spec";

// =============================================================================
// TYPES
// =============================================================================

/** Core schemas for a model (combined field + relation schemas) */
export interface CoreSchemas {
  // Field-level combined
  scalarFilter: VibSchema;
  scalarCreate: VibSchema;
  scalarUpdate: VibSchema;

  // Relation-level combined
  relationFilter: VibSchema;
  relationCreate: VibSchema;
  relationUpdate: VibSchema;

  // Full combined (scalar + relation)
  where: VibSchema;
  whereUnique: VibSchema;
  create: VibSchema;
  update: VibSchema;
  select: VibSchema;
  include: VibSchema;
  orderBy: VibSchema;
}

/** Operation argument schemas */
export interface ArgsSchemas {
  findUnique: VibSchema;
  findFirst: VibSchema;
  findMany: VibSchema;
  create: VibSchema;
  createMany: VibSchema;
  update: VibSchema;
  updateMany: VibSchema;
  delete: VibSchema;
  deleteMany: VibSchema;
  upsert: VibSchema;
  count: VibSchema;
  aggregate: VibSchema;
  groupBy: VibSchema;
}

/** All schemas for a single model */
export interface ModelSchemas<M extends AnyModel = AnyModel> {
  /** Per-field schemas keyed by field name */
  scalars: GetScalarsSchemas<M>;
  /** Per-relation schemas keyed by relation name */
  relations: GetRelationsSchemas<M>;
  /** Combined core schemas */
  core: CoreSchemas;
  /** Operation argument schemas */
  args: ArgsSchemas;
}

export type FieldSchemas<M extends AnyModel> = {
  relations: GetRelationsSchemas<M>;
  scalars: GetScalarsSchemas<M>;
};

export type AnyFieldSchema = FieldSchemas<any>;

// =============================================================================
// SCHEMA REGISTRY
// =============================================================================

const user = s.model({
  id: s.string().id().schema(z.string().brand("$$")),
  posts: s.oneToMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  auhtor: s.manyToOne(() => user),
});
const schema = {
  user,
  post,
};

export class SchemaRegistry<S extends Record<string, AnyModel>> {
  private readonly cache = new Map<AnyModel, ModelSchemas>();
  proxy: {
    [K in keyof S]: ModelSchemas<S[K]>;
  };

  constructor(schema: S) {
    const getOrSetModelSchemas = this.getOrSetModelSchemas;

    this.proxy = new Proxy(
      {},
      {
        get(target, prop) {
          if (typeof prop !== "string" || !(prop in schema) || !schema[prop]) {
            throw new Error(`${String(prop)} does not exist`);
          }
          return getOrSetModelSchemas(schema[prop]);
        },
      },
    ) as {
      [K in keyof S]: ModelSchemas<S[K]>;
    };
  }

  private createSchemasGetter = <S extends RelationState>(state: S) => {
    return () => {
      const targetModel = state.getter() as AnyModel;
      return this.getOrSetModelSchemas(
        targetModel,
      ) as unknown as GetTargetSchemas<S>;
    };
  };

  buildModelSchemas = (model: AnyModel): ModelSchemas => {
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

  getOrSetModelSchemas = (model: AnyModel) => {
    let schemas = this.cache.get(model);
    if (!schemas) {
      schemas = this.buildModelSchemas(model);
      this.cache.set(model, schemas);
    }
    return schemas as ModelSchemas<AnyModel>;
  };

  validate = (
    model: string,
    operation: keyof ArgsSchemas,
    payload: unknown,
  ) => {
    const schemas = this.proxy[model]!;
    const result = schemas.args[operation]["~standard"].validate(payload);
    if (result instanceof Promise) {
      throw new ValidationError(operation, [], {
        meta: { model, hint: "Async validation is not supported" },
      });
    }
    if (result.issues) {
      const issues = result.issues.map((issue) => ({
        path: issue.path?.map((p) => p).join(".") ?? "",
        message: issue.message,
      }));
      throw new ValidationError(operation, issues, { meta: { model } });
    }
    return result.value;
  };
}

export const createSchemaRegistry = <S extends Record<string, Model<any>>>(
  schema: S,
): SchemaRegistry<S> => {
  return new SchemaRegistry(schema);
};

const registry = createSchemaRegistry(schema);

const include = getIncludeSchema({
  relations: registry.proxy.user.relations,
  scalars: registry.proxy.user.scalars,
});

type Test = Simplify<StandardSchemaV1.InferInput<typeof include>>;
