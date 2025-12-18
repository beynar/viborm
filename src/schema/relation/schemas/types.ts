// Relation schema types

import type { BaseSchema, InferInput } from "valibot";
import type { RelationState } from "../relation";

/**
 * Generic relation schema type
 */
export type AnyRelationSchema = BaseSchema<any, any, any>;

/**
 * Complete set of schemas for a relation
 */
export interface RelationSchemas {
  filter: AnyRelationSchema;
  create: AnyRelationSchema;
  update: AnyRelationSchema;
  select: AnyRelationSchema;
  include: AnyRelationSchema;
}

/**
 * Type inference for to-one relation schemas
 */
export type ToOneSchemas<S extends RelationState> = RelationSchemas;

/**
 * Type inference for to-many relation schemas
 */
export type ToManySchemas<S extends RelationState> = RelationSchemas;

/**
 * Conditional type inference based on relation type
 */
export type InferRelationSchemas<S extends RelationState> = S["type"] extends
  | "manyToMany"
  | "oneToMany"
  ? ToManySchemas<S>
  : ToOneSchemas<S>;

/**
 * Infer input type for a specific relation schema
 */
export type InferRelationInput<
  S extends RelationState,
  Type extends keyof RelationSchemas
> = InferInput<InferRelationSchemas<S>[Type]>;

